// Sessions module — live JSONL tail for closure carriers that the SDK
// `query()` async iterator does not yield.
//
// Background: Claude Code's CLI emits two envelope types that complete a
// `run_in_background:true` Bash dispatch — `queue-operation` enqueue with
// a `<task-notification>` XML body, and `attachment.queued_command` with
// the same XML in `prompt`. Neither type is a member of the SDK's
// `SDKMessage` discriminated union, so the renderer's normal subscription
// to `claude-output:<tabId>` never sees them in live mode. Without those
// carriers, background dispatches stay in `running` forever (the user-
// visible bug we're fixing — see the design spec under
// `docs/superpowers/specs/2026-05-11-subagent-tracking-refactor-design.md`).
//
// The CLI does persist these envelopes to the session JSONL on disk, so we
// tail that file and forward only the qualifying carriers on a separate
// IPC channel (`claude-output-extra:<tabId>`). All other line types are
// ignored — the SDK stream remains the source of truth for them.
//
// This module is renderer-process-agnostic. It exposes a small handle that
// the runtime starts when a session's `sessionId` is known and stops on
// close / error / handle replacement. Path resolution and IPC wiring live
// in `runtime.ts`.

import fs from 'node:fs';

export interface CreateJsonlTailArgs {
  /** Absolute path to the JSONL file to watch. Need not exist yet — the
   *  tail will poll for its appearance. */
  jsonlPath: string;
  /** Called for each forwarded line. Already-parsed JSON; the caller does
   *  not need to JSON.parse. */
  onMessage: (msg: unknown) => void;
  /** Called for unexpected errors. Failures are otherwise silent (the tail
   *  is best-effort — losing the carrier means a row stays `running`,
   *  which is annoying but not data-corrupting). */
  onError?: (err: unknown) => void;
  /**
   * Which parsed lines to forward. Defaults to `'closure-carriers'` so
   * existing SDK-mode call sites keep their narrow surface.
   * - `'closure-carriers'`: only `queue-operation`/`attachment` lines that
   *   carry `<task-notification>` XML (today's behavior).
   * - `'all'`: every parsed line, regardless of type. Used by TUI mode to
   *   drive the rich-message panel and notifications from JSONL.
   */
  filter?: 'closure-carriers' | 'all';
}

export interface JsonlTailHandle {
  /** Release the watcher and any pending timers. Idempotent. */
  stop: () => void;
}

// Polling cadence for the active tail. `fs.watch` is unreliable on macOS
// (and inconsistent across platforms) when watching individual files;
// `fs.watchFile` uses stat polling which is slower per change but works
// the same everywhere. 100ms is well under the renderer-visible threshold
// and the cost is one `stat` per session per tick — negligible.
const POLL_INTERVAL_MS = 100;
// Poll cadence while the JSONL doesn't exist yet. The CLI typically
// creates the file within ~200ms of session start; 200ms hits a balance
// between snappiness and idle CPU.
const ENOENT_POLL_MS = 200;

/**
 * True for messages we want to forward to the renderer. Right now: just
 * `queue-operation` enqueues carrying `<task-notification>` XML, and
 * `attachment.queued_command` with the same. Tightening this filter (vs
 * forwarding everything) keeps `claude-output-extra:<tabId>` semantically
 * narrow — the renderer can assume any message it receives on that channel
 * is a closure carrier.
 */
export function isClosureCarrier(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const m = parsed as Record<string, unknown>;
  if (m.type === 'queue-operation') {
    if (m.operation !== 'enqueue') return false;
    const content = m.content;
    return typeof content === 'string' && content.includes('<task-notification>');
  }
  if (m.type === 'attachment') {
    const att = m.attachment as { type?: string; prompt?: unknown } | undefined;
    return (
      att?.type === 'queued_command' &&
      typeof att.prompt === 'string' &&
      att.prompt.includes('<task-notification>')
    );
  }
  return false;
}

export function createJsonlTail(args: CreateJsonlTailArgs): JsonlTailHandle {
  const { jsonlPath, onMessage, onError, filter = 'closure-carriers' } = args;
  let offset = 0;
  let pendingTail = '';
  let drainPoll: NodeJS.Timeout | null = null;
  let waitPoll: NodeJS.Timeout | null = null;
  let stopped = false;

  const safeFire = (err: unknown): void => {
    try {
      onError?.(err);
    } catch {
      /* swallow — the consumer is best-effort */
    }
  };

  const shouldForward = filter === 'all' ? () => true : isClosureCarrier;

  const drain = (): void => {
    if (stopped) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(jsonlPath);
    } catch (err) {
      // File disappeared (rotation) — reset and wait for it to reappear.
      offset = 0;
      pendingTail = '';
      stopDrainPoll();
      startWaitingForFile();
      safeFire(err);
      return;
    }
    // External truncation / rotation: size shrank.
    if (stat.size < offset) {
      offset = 0;
      pendingTail = '';
    }
    if (stat.size === offset) return;
    const len = stat.size - offset;
    const buf = Buffer.alloc(len);
    let fd: number;
    try {
      fd = fs.openSync(jsonlPath, 'r');
    } catch (err) {
      safeFire(err);
      return;
    }
    try {
      fs.readSync(fd, buf, 0, len, offset);
    } catch (err) {
      safeFire(err);
      return;
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    offset = stat.size;
    const text = pendingTail + buf.toString('utf8');
    const lines = text.split('\n');
    // The last element is whatever follows the final \n — typically an
    // empty string when the file ends cleanly, or a partial line if a
    // write split mid-line. Hold it until the next drain.
    pendingTail = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (shouldForward(parsed)) {
        try {
          onMessage(parsed);
        } catch (err) {
          safeFire(err);
        }
      }
    }
  };

  const stopDrainPoll = (): void => {
    if (drainPoll) {
      clearInterval(drainPoll);
      drainPoll = null;
    }
  };

  // When the file already exists at tail-creation time, start reading from
  // current EOF (historical content is loaded via loadSessionHistory). When
  // the file appears later (ENOENT path), forward everything from byte 0 —
  // those lines genuinely arrived during the tail's lifetime.
  //
  // Internal polling (setInterval + statSync) rather than fs.watchFile /
  // fs.watch: the OS-level watchers are unreliable under heavy parallel
  // load (Node's coordinator can silently coalesce or drop events when
  // many file handles are active). Our cost is one stat() per session per
  // 100ms — completely negligible — and the behaviour is deterministic
  // across platforms and load levels.
  const startWatching = (skipExistingContent: boolean): void => {
    if (stopped || drainPoll) return;
    if (skipExistingContent) {
      try {
        offset = fs.statSync(jsonlPath).size;
      } catch {
        offset = 0;
      }
    } else {
      offset = 0;
    }
    drainPoll = setInterval(() => {
      if (stopped) {
        stopDrainPoll();
        return;
      }
      drain();
    }, POLL_INTERVAL_MS);
  };

  const startWaitingForFile = (): void => {
    if (stopped) return;
    if (waitPoll) return;
    waitPoll = setInterval(() => {
      if (stopped) {
        if (waitPoll) clearInterval(waitPoll);
        waitPoll = null;
        return;
      }
      if (fs.existsSync(jsonlPath)) {
        if (waitPoll) clearInterval(waitPoll);
        waitPoll = null;
        // File came into being during our lifetime — its contents are live
        // appends as far as we're concerned, so forward from byte 0.
        startWatching(false);
        drain();
      }
    }, ENOENT_POLL_MS);
  };

  // Kick things off.
  if (fs.existsSync(jsonlPath)) {
    startWatching(true);
  } else {
    startWaitingForFile();
  }

  return {
    stop: () => {
      stopped = true;
      if (waitPoll) {
        clearInterval(waitPoll);
        waitPoll = null;
      }
      stopDrainPoll();
    },
  };
}
