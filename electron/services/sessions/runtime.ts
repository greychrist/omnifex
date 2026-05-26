// Sessions module — engine stream runtime
//
// Drives the per-session message stream by subscribing to an AgentEngine's
// event callbacks. Owns: status transitions, stream-error recovery (engine
// restart with --resume), JSONL-tail wiring for subagent carriers, and the
// StrictMode / TUI-handoff identity-replace guards.

import path from 'node:path';
import fs from 'node:fs';
import type {
  SessionHandle,
  SendToRenderer,
  NotificationHooks,
  RateLimitHook,
  SessionOwnership,
  LoggingService,
} from './types';
import type { AgentMessage } from '../agents/types';
import { classifyRuntimeEvent } from './events';
import { dispatchResultNotification } from './notifications';
import { createJsonlTail, type JsonlTailHandle } from './jsonl-tail';
import { encodeProjectKey } from './summary-query';
import { setStatus } from './status';

export interface RuntimeDeps {
  sendToRenderer: SendToRenderer;
  notificationHooks: NotificationHooks;
  rateLimitHook: RateLimitHook | null;
  ownership: SessionOwnership | null;
  /**
   * Live session map. Runtime uses identity-checks
   * (sessions.get(tabId) !== handle) to skip cleanup when start() has
   * already replaced the handle (StrictMode double-mount, explicit
   * re-start), and the deletion to drop dead sessions on clean close.
   */
  sessions: Map<string, SessionHandle>;
  /**
   * Optional app_logs sink. Engine errors are written here at level=error
   * so the renderer toast (wired in main.ts via the LoggingService onError
   * observer) fires for every CLI stderr line we surface. Distinct from
   * `sendToRenderer('claude-error:…')`, which is a console-level diagnostic
   * stream the renderer's `LogService` already routes to app_logs as a
   * `frontend`-source entry. Both are kept: backend-source rows attribute
   * the error to the session runtime, frontend-source rows attribute it
   * to the renderer code path that observed it.
   */
  logging?: LoggingService | null;
}

interface JsonlTailState {
  tail: JsonlTailHandle | null;
}

function ensureJsonlTail(
  handle: SessionHandle,
  tabId: string,
  state: JsonlTailState,
  sendToRenderer: SendToRenderer,
): void {
  if (state.tail || !handle.sessionId) return;
  if (process.env.OMNIFEX_DISABLE_JSONL_TAIL === '1') return;
  const projectId = encodeProjectKey(handle.projectPath);
  const jsonlPath = path.join(
    handle.configDir,
    'projects',
    projectId,
    `${handle.sessionId}.jsonl`,
  );
  state.tail = createJsonlTail({
    jsonlPath,
    onMessage: (msg) => {
      // Surface on a separate channel so the renderer's normal
      // claude-output:* subscription stays 1:1 with engine output.
      sendToRenderer(`claude-output-extra:${tabId}`, msg);
    },
    onError: (err) => {
      console.warn('[sessions] jsonl-tail error:', err);
    },
  });
}

function teardownJsonlTail(state: JsonlTailState): void {
  if (!state.tail) return;
  try {
    state.tail.stop();
  } catch {
    /* ignore */
  }
  state.tail = null;
}

/**
 * Subscribe to the session's engine and drive the FSM. Returns a Promise
 * that resolves when the engine exits (cleanly or via error). Caller fires
 * and forgets — the promise just lets the listener loop be awaited if
 * needed.
 *
 * Status transitions are identical to the prior SDK-driven loop:
 *  - system:init    → sessionStatus='started', conversationStatus='idle'
 *  - turn / rate    → conversationStatus='running'
 *  - result         → conversationStatus='idle'  (after notification dispatch)
 *  - engine error   → sessionStatus='error'    (next send triggers restart)
 *  - engine exit    → sessionStatus='stopped'  (clean close)
 */
export function listenToMessages(
  tabId: string,
  handle: SessionHandle,
  deps: RuntimeDeps,
): Promise<void> {
  const { sendToRenderer, notificationHooks, rateLimitHook, ownership, sessions, logging } = deps;
  const engine = handle.engine;
  if (!engine) return Promise.resolve();

  const jsonlState: JsonlTailState = { tail: null };
  let exitResolve: (() => void) | null = null;
  const done = new Promise<void>((resolve) => { exitResolve = resolve; });

  // Attach the JSONL tail immediately — sessionId is pinned at spawn
  // (lifecycle minted it before calling us), so the tail path is known.
  // The tail surfaces background-Bash queue-operation carriers and
  // queued_command attachments that the stream-json output may not yield.
  ensureJsonlTail(handle, tabId, jsonlState, sendToRenderer);

  const subscriptions = [
    engine.onMessage((agentMsg: AgentMessage) => {
      const message = agentMsg.payload as Record<string, unknown>;
      const event = classifyRuntimeEvent(message);
      (message as Record<string, unknown>).receivedAt = agentMsg.receivedAt;

      switch (event.kind) {
        case 'init':
          // The CLI emits `system:init` mid-turn AFTER the first user
          // message, NOT on spawn. By the time this fires, lifecycle has
          // already flipped sessionStatus to 'started' from engine.start()
          // resolution. We do NOT setStatus here — doing so would stomp
          // conversationStatus from 'running' back to 'idle' mid-turn and
          // flicker the loading indicator. Only capture catalog data
          // (commands/models/agents/account) that arrives in this payload:
          if (!handle.initData) handle.initData = engine.getInitData();
          break;
        case 'rateLimit':
          if (rateLimitHook) {
            try {
              rateLimitHook(handle.configDir, event.info);
            } catch (err) {
              console.error('[sessions] rate-limit hook failed:', err);
            }
          }
          setStatus(handle, { conversationStatus: 'running' }, tabId, sendToRenderer);
          break;
        case 'compact':
        case 'turn':
          setStatus(handle, { conversationStatus: 'running' }, tabId, sendToRenderer);
          break;
        case 'streamEvent':
          break;
        case 'result':
          // status flip after notification dispatch below
          break;
      }

      sendToRenderer(`claude-output:${tabId}`, message);

      if (event.kind === 'result') {
        dispatchResultNotification({
          tabId,
          projectPath: handle.projectPath,
          event,
          sendToRenderer,
          notificationHooks,
        });
        setStatus(handle, { conversationStatus: 'idle' }, tabId, sendToRenderer);
      }
    }),

    // engine.onError fires for every non-empty stderr line from the CLI
    // (claude-cli-engine.ts:wireStderr). That includes benign noise like
    // MCP-auth notices and deprecation warnings — NOT a "session over"
    // signal. The only authoritative terminal event is engine.onExit
    // (CLI subprocess actually exited).
    //
    // So: surface the error so the user sees it (toast via the LoggingService
    // onError observer wired in main.ts) and keep going. We do NOT:
    //   - emit claude-complete (the renderer treats that as "tear down all
    //     IPC listeners for this session" — see useSessionLifecycle.ts);
    //   - flip sessionStatus to 'error' (next message would still arrive
    //     under a live session, but the badge would lie);
    //   - inject a synthetic 'Session Error' card into the message stream
    //     (it presents as a session-ending result and confuses the user
    //     when the session is in fact still alive).
    //
    // `claude-error:<tabId>` is still emitted so the renderer's LogService
    // captures the stderr line as a frontend-source app_log entry — that's
    // separate from the backend-source app_log we write below, and both
    // serve different attribution lookups in the Log tab.
    engine.onError((err: Error) => {
      if (handle.mode === 'tui') return;
      if (sessions.get(tabId) !== handle) return;
      const errMsg = err instanceof Error ? err.message : String(err);
      sendToRenderer(`claude-error:${tabId}`, errMsg);
      if (logging) {
        try {
          logging.writeBatch([{
            timestamp: new Date().toISOString(),
            level: 'error',
            source: 'backend',
            category: `session:${tabId}`,
            message: `engine error (session continues): ${errMsg.slice(0, 500)}`,
          }]);
        } catch {
          // Logging must never break the session loop.
        }
      }
    }),

    engine.onExit(() => {
      // TUI mid-switch: lifecycle owns cleanup, do nothing.
      if (handle.mode === 'tui') {
        teardownJsonlTail(jsonlState);
        for (const s of subscriptions) s.dispose();
        if (exitResolve) exitResolve();
        return;
      }
      // start() replaced the handle (StrictMode / explicit re-start)?
      // Suppress all renderer-facing events.
      if (sessions.get(tabId) !== handle) {
        teardownJsonlTail(jsonlState);
        for (const s of subscriptions) s.dispose();
        if (exitResolve) exitResolve();
        return;
      }
      setStatus(handle, { sessionStatus: 'stopped' }, tabId, sendToRenderer);
      sendToRenderer(`claude-complete:${tabId}`);
      sessions.delete(tabId);
      ownership?.unregister(tabId);
      teardownJsonlTail(jsonlState);
      for (const s of subscriptions) s.dispose();
      if (exitResolve) exitResolve();
    }),
  ];

  return done;
}

/**
 * Restart a dead engine (after stream error) so the session resumes.
 * Engine.start is re-entrant; calling it tears down any prior child and
 * spawns a fresh one against the captured sessionId — `--resume` when the
 * CLI has already written a JSONL for it, `--session-id` when it hasn't.
 *
 * The JSONL check exists because the CLI exits with "No conversation found
 * with session ID …" if `--resume <id>` is passed against a non-existent
 * transcript. That happens on the tui → rich return path when the user
 * never sent a message in either mode, so no JSONL was ever written. The
 * same protection lives at setMode('tui') around its createTuiSession call.
 */
export function restartQuery(
  tabId: string,
  handle: SessionHandle,
  deps: RuntimeDeps,
): void {
  if (!handle.engine) return;
  if (!handle.sessionId) {
    console.error(`[sessions] restartQuery: no sessionId for tab ${tabId}`);
    return;
  }
  const jsonlPath = path.join(
    handle.startParams.configDir,
    'projects',
    encodeProjectKey(handle.startParams.projectPath),
    `${handle.sessionId}.jsonl`,
  );
  const resume = fs.existsSync(jsonlPath);
  setStatus(handle, { sessionStatus: 'starting' }, tabId, deps.sendToRenderer);
  void handle.engine.start({
    projectPath: handle.startParams.projectPath,
    configDir: handle.startParams.configDir,
    model: handle.startParams.model,
    permissionMode: handle.startParams.permissionMode,
    sessionId: handle.sessionId,
    resume,
  }).then(() => {
    setStatus(handle, { sessionStatus: 'started', conversationStatus: 'idle' }, tabId, deps.sendToRenderer);
  }).catch((err: unknown) => {
    console.error(`[sessions] engine.start (restart) failed for tab ${tabId}:`, err);
    setStatus(handle, { sessionStatus: 'error' }, tabId, deps.sendToRenderer);
  });
}
