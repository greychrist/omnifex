// Sessions module — SDK stream runtime
// Owns the per-session message-listener loop and the post-error restart
// path. Extracted from lifecycle.ts so the FSM (status transitions,
// stream-error recovery, StrictMode-double-mount guards, TUI-handoff
// guards) is isolated and explicit.

import path from 'node:path';
import { createAsyncChannel } from '../async-channel';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  SessionHandle,
  SendToRenderer,
  NotificationHooks,
  RateLimitHook,
  SessionOwnership,
} from './types';
import { classifyRuntimeEvent } from './events';
import { dispatchResultNotification } from './notifications';
import { createJsonlTail, type JsonlTailHandle } from './jsonl-tail';
import { encodeProjectKey } from './summary-query';

export interface RuntimeDeps {
  sendToRenderer: SendToRenderer;
  notificationHooks: NotificationHooks;
  rateLimitHook: RateLimitHook | null;
  ownership: SessionOwnership | null;
  /**
   * The live session map. The runtime needs identity-checks
   * (sessions.get(tabId) !== handle) to skip cleanup when start() has
   * already replaced the handle (StrictMode double-mount, explicit
   * re-start), and the deletion to drop dead sessions on clean close.
   */
  sessions: Map<string, SessionHandle>;
}

/**
 * Drive the SDK message stream for one session. Resolves when the
 * stream closes (cleanly or via error).
 *
 * Status transitions:
 *  - `system:init`     → 'idle'   (alive, no turn yet — installer's
 *                                  wait-for-idle gate must not block)
 *  - `result`          → 'idle'   (turn complete, awaiting next input)
 *  - anything else     → 'running' (mid-turn)
 *  - stream throws     → 'error'  (next sendMessage triggers restart)
 *  - clean close       → 'stopped'
 *
 * sendMessage() also sets 'running' eagerly so the gate reacts the
 * moment the user submits, before the SDK echoes anything.
 */
export async function listenToMessages(
  tabId: string,
  handle: SessionHandle,
  deps: RuntimeDeps,
): Promise<void> {
  // listenToMessages is only called for SDK-mode sessions. If query is null
  // (TUI cold-start), there is nothing to iterate — return immediately.
  if (!handle.query) return;
  const { sendToRenderer, notificationHooks, rateLimitHook, ownership, sessions } = deps;
  // JSONL tail for closure carriers the SDK iterator doesn't yield
  // (queue-operation enqueue with <task-notification>, attachment
  // queued_command). Wired up the first time we see a sessionId, since
  // that's when the JSONL path becomes resolvable. Released in every
  // cleanup branch below — clean close, stream error, identity-replace.
  // See `jsonl-tail.ts` and the design spec under
  // docs/superpowers/specs/2026-05-11-subagent-tracking-refactor-design.md.
  let jsonlTail: JsonlTailHandle | null = null;
  const ensureJsonlTail = (): void => {
    if (jsonlTail || !handle.sessionId) return;
    if (process.env.OMNIFEX_DISABLE_JSONL_TAIL === '1') return;
    const projectId = encodeProjectKey(handle.projectPath);
    const jsonlPath = path.join(handle.configDir, 'projects', projectId, `${handle.sessionId}.jsonl`);
    jsonlTail = createJsonlTail({
      jsonlPath,
      onMessage: (msg) => {
        // Surface on a separate channel so the renderer's normal
        // claude-output:* subscription stays 1:1 with SDK output and
        // these carriers can be routed through their own handler.
        sendToRenderer(`claude-output-extra:${tabId}`, msg);
      },
      onError: (err) => {
        // Best-effort — losing a carrier leaves a row stuck running, which
        // is annoying but not data-corrupting. Log so the gap is visible.
        console.warn('[sessions] jsonl-tail error:', err);
      },
    });
  };
  const teardownJsonlTail = (): void => {
    if (!jsonlTail) return;
    try {
      jsonlTail.stop();
    } catch {
      /* ignore */
    }
    jsonlTail = null;
  };
  try {
    for await (const message of handle.query) {
      const event = classifyRuntimeEvent(message);

      // Stamp each live message with the wall-clock time we received it,
      // so the renderer can show a per-card timestamp. Reloaded-from-JSONL
      // messages won't have this field (the SDK's JSONL has no timestamp),
      // and the renderer treats that case as "no timestamp".
      (message as any).receivedAt = new Date().toISOString();

      // Status transitions:
      //  - 'init' means the session is alive but no turn is in flight yet
      //    → 'idle' so the installer's wait-for-idle gate doesn't block.
      //  - 'result' is handled below (also flips to 'idle').
      //  - Anything else (assistant / tool_use / tool_result / etc.) means
      //    the SDK is mid-turn → 'running'.
      // sendMessage() also sets 'running' eagerly so the gate reacts the
      // moment the user submits, before the SDK echoes anything.
      switch (event.kind) {
        case 'init':
          if (event.sessionId) handle.sessionId = event.sessionId;
          handle.status = 'idle';
          // First time we know the sessionId — wire up the JSONL tail so
          // background-Bash closure carriers (queue-operation enqueue /
          // attachment queued_command) reach the renderer in live mode.
          ensureJsonlTail();
          break;
        case 'rateLimit':
          // Capture rate-limit events for the rate-limits service. Wrap in
          // try/catch so a downstream bug never kills the session stream.
          if (rateLimitHook) {
            try {
              rateLimitHook(handle.configDir, event.info);
            } catch (err) {
              console.error('[sessions] rate-limit hook failed:', err);
            }
          }
          handle.status = 'running';
          break;
        case 'compact':
          // Stream paused for compaction. Treat as 'running' for now —
          // the FSM doesn't have a separate 'compacting' status today,
          // but classifying separately leaves room for one if/when the
          // status badge wants to distinguish it.
          handle.status = 'running';
          break;
        case 'streamEvent':
          // Token-level partial delta (emitted because includePartialMessages: true
          // is set in factory.ts). Keep status as-is: status transitions are driven
          // by turn-level events, not per-token deltas.
          break;
        case 'turn':
          handle.status = 'running';
          break;
        case 'result':
          // status flip happens after notification dispatch below
          break;
      }

      // Forward every message to the renderer
      sendToRenderer(`claude-output:${tabId}`, message);

      if (event.kind === 'result') {
        dispatchResultNotification({
          tabId,
          projectPath: handle.projectPath,
          event,
          sendToRenderer,
          notificationHooks,
        });
        // Turn is over — flip to 'idle' so the installer's wait-for-idle
        // gate doesn't block on a tab that's just sitting waiting for the
        // user. The 'turn' branch above will move us back to 'running' the
        // moment the next message lands on the stream.
        handle.status = 'idle';
      }
    }
  } catch (err) {
    // If we're mid-switch to TUI, swallow whatever the old stream threw —
    // the mode handler owns lifecycle from here. Do NOT fire claude-error /
    // claude-complete, which would wipe renderer state (isSessionActive).
    if (handle.mode === 'tui') {
      teardownJsonlTail();
      return;
    }
    // If start() has already replaced this handle (StrictMode double-mount,
    // or any explicit re-start), the throw was caused by `inputChannel.close()`
    // in start() itself. Suppress all renderer-facing events so the new
    // session's listeners don't see a spurious error from the old one.
    if (sessions.get(tabId) !== handle) {
      teardownJsonlTail();
      return;
    }
    // Stream error — keep the session alive so the user can retry.
    // The next sendMessage() will restart the SDK query transparently.
    handle.status = 'error';
    // Close the dead Query handle so its internals are released. The
    // SDK's Query.close() is idempotent; without this the dying handle
    // hangs around in handle.query holding subprocess resources until
    // either stop() or restartQuery() eventually replaces it.
    try {
      handle.query?.close();
    } catch (closeErr) {
      console.warn('[sessions] query.close on stream error threw:', closeErr);
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    sendToRenderer(`claude-error:${tabId}`, errMsg);
    sendToRenderer(`claude-output:${tabId}`, {
      type: 'system',
      subtype: 'notification',
      notification_type: 'error',
      title: 'Session Error',
      body: `Error: ${errMsg.slice(0, 200)}`,
    });
    // Stop the loading indicator but keep the session in the map
    sendToRenderer(`claude-complete:${tabId}`);
    teardownJsonlTail();
    return;
  }
  // Normal stream close — clean up (unless we're mid-switch to TUI mode,
  // in which case the session stays alive and mode handles its own lifecycle)
  if (handle.mode === 'tui') {
    teardownJsonlTail();
    return;
  }
  // If start() has replaced this handle in the map (StrictMode double-mount
  // or an explicit re-start path), the loop terminated because start() closed
  // our inputChannel. The newly-registered handle is what the renderer cares
  // about now — emitting claude-complete here would flip its session state to
  // 'ended', and `sessions.delete(tabId)` would wipe the new handle from the
  // map. Bail without touching either.
  if (sessions.get(tabId) !== handle) {
    teardownJsonlTail();
    return;
  }
  handle.status = 'stopped';
  sendToRenderer(`claude-complete:${tabId}`);
  sessions.delete(tabId);
  ownership?.unregister(tabId);
  teardownJsonlTail();
}

/**
 * Restart a dead query (after stream error) so the session resumes.
 * Resets handle.inputChannel, handle.query, handle.status, then re-fires
 * listenToMessages on the new query.
 */
export function restartQuery(
  tabId: string,
  handle: SessionHandle,
  deps: RuntimeDeps,
): void {
  const newInputChannel = createAsyncChannel<SDKUserMessage>(1000);
  const opts = { ...handle.sdkOptions };
  if (handle.sessionId) {
    opts.resume = handle.sessionId;
  }

  const q = query({
    prompt: newInputChannel,
    options: opts,
  });

  handle.inputChannel = newInputChannel;
  handle.query = q;
  handle.status = 'starting';

  listenToMessages(tabId, handle, deps).catch((err: unknown) => {
    console.error(`[sessions] Unhandled error in listenToMessages for tab ${tabId}:`, err);
  });
}
