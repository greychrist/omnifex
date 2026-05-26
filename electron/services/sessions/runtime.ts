// Sessions module — engine stream runtime
//
// Drives the per-session message stream by subscribing to an AgentEngine's
// event callbacks. Owns: status transitions, stream-error recovery (engine
// restart with --resume), JSONL-tail wiring for subagent carriers, and the
// StrictMode / TUI-handoff identity-replace guards.

import path from 'node:path';
import type {
  SessionHandle,
  SendToRenderer,
  NotificationHooks,
  RateLimitHook,
  SessionOwnership,
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
  const { sendToRenderer, notificationHooks, rateLimitHook, ownership, sessions } = deps;
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

      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('node:fs').appendFileSync('/tmp/omnifex-engine.log',
          `${new Date().toISOString()} [${tabId}] EMIT claude-output type=${(message as any).type ?? '?'} subtype=${(message as any).subtype ?? ''}\n`);
      } catch { /* ignore */ }
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

    engine.onError((err: Error) => {
      if (handle.mode === 'tui') return;
      if (sessions.get(tabId) !== handle) return;
      setStatus(handle, { sessionStatus: 'error' }, tabId, sendToRenderer);
      const errMsg = err instanceof Error ? err.message : String(err);
      sendToRenderer(`claude-error:${tabId}`, errMsg);
      sendToRenderer(`claude-output:${tabId}`, {
        type: 'system',
        subtype: 'notification',
        notification_type: 'error',
        title: 'Session Error',
        body: `Error: ${errMsg.slice(0, 200)}`,
      });
      sendToRenderer(`claude-complete:${tabId}`);
      teardownJsonlTail(jsonlState);
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
 * spawns a fresh one with --resume against the captured sessionId.
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
  setStatus(handle, { sessionStatus: 'starting' }, tabId, deps.sendToRenderer);
  void handle.engine.start({
    projectPath: handle.startParams.projectPath,
    configDir: handle.startParams.configDir,
    model: handle.startParams.model,
    permissionMode: handle.startParams.permissionMode,
    // Resume the same session id so the JSONL continues uninterrupted.
    sessionId: handle.sessionId,
    resume: true,
  }).then(() => {
    setStatus(handle, { sessionStatus: 'started', conversationStatus: 'idle' }, tabId, deps.sendToRenderer);
  }).catch((err: unknown) => {
    console.error(`[sessions] engine.start (restart) failed for tab ${tabId}:`, err);
    setStatus(handle, { sessionStatus: 'error' }, tabId, deps.sendToRenderer);
  });
}
