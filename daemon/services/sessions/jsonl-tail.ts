// The CLI writes closure carriers (`queue-operation`, `attachment.queued_command`) to the JSONL but never streams them;
// without them background dispatches stay `running` forever.

import fs from 'node:fs';
import { isRequestReplayLine } from '../util/request-replay';

export interface CreateJsonlTailArgs {
  jsonlPath: string;
  onMessage: (msg: unknown) => void;
  onError?: (err: unknown) => void;
  filter?: 'closure-carriers' | 'all';
  // The CLI moves a live transcript when the session enters a worktree (`EnterWorktree`).
  locate?: () => string | null;
}

export interface JsonlTailHandle {
  stop: () => void;
}

// Stat polling, not `fs.watch`: unreliable on macOS for single files and under load.
const POLL_INTERVAL_MS = 100;
const ENOENT_POLL_MS = 200;

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
  const { onMessage, onError, filter = 'closure-carriers', locate } = args;
  let jsonlPath = args.jsonlPath;
  let offset = 0;
  // Bytes, not a string: a multibyte codepoint can straddle a read boundary.
  let pendingTail: Buffer = Buffer.alloc(0);
  const NEWLINE = 0x0a;
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

  const followMove = (): boolean => {
    let moved: string | null = null;
    try {
      moved = locate?.() ?? null;
    } catch (err) {
      safeFire(err);
    }
    if (!moved || moved === jsonlPath || !fs.existsSync(moved)) return false;
    jsonlPath = moved;
    return true;
  };

  const drain = (): void => {
    if (stopped) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(jsonlPath);
    } catch (err) {
      // A rename keeps every byte already read, so the offset and partial line carry over.
      if (followMove()) {
        drain();
        return;
      }
      offset = 0;
      pendingTail = Buffer.alloc(0);
      stopDrainPoll();
      startWaitingForFile();
      safeFire(err);
      return;
    }
    if (stat.size < offset) {
      offset = 0;
      pendingTail = Buffer.alloc(0);
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
    const combined = pendingTail.length ? Buffer.concat([pendingTail, buf]) : buf;
    let lineStart = 0;
    let nl = combined.indexOf(NEWLINE, lineStart);
    while (nl !== -1) {
      const line = combined.toString('utf8', lineStart, nl);
      lineStart = nl + 1;
      nl = combined.indexOf(NEWLINE, lineStart);
      if (!line || isRequestReplayLine(line)) continue;
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
    pendingTail = lineStart < combined.length ? combined.subarray(lineStart) : Buffer.alloc(0);
  };

  const stopDrainPoll = (): void => {
    if (drainPoll) {
      clearInterval(drainPoll);
      drainPoll = null;
    }
  };

  // An existing file starts at EOF (history loads separately); one that appears later is forwarded from byte 0.
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
        startWatching(false);
        drain();
      }
    }, ENOENT_POLL_MS);
  };

  if (fs.existsSync(jsonlPath) || followMove()) {
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
