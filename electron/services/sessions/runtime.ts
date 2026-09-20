// Sessions module — engine stream runtime
//
// Drives the per-session message stream by subscribing to an AgentEngine's
// event callbacks. Owns: status transitions, stream-error recovery (engine
// restart with --resume), JSONL-tail wiring, and the StrictMode
// identity-replace guard.
//
// The tail is the transcript source, not a supplement to stream-json. See
// ensureJsonlTail and ./stream-forward.ts for the split and why it exists.

import path from 'node:path';
import type {
  SessionHandle,
  SendToRenderer,
  NotificationHooks,
  RateLimitHook,
  SessionOwnership,
  LoggingService,
  AccountMismatch,
} from './types';
import type { AgentMessage } from '../agents/types';
import { classifyRuntimeEvent } from './events';
import { dispatchAgentNotification, dispatchResultNotification } from './notifications';
import { createBackgroundTaskTracker } from './background-tasks';
import { createJsonlTail, isClosureCarrier, type JsonlTailHandle } from './jsonl-tail';
import { shouldForwardStreamMessage } from './stream-forward';
import { encodeProjectId, hasTranscript } from '../project-paths';
import { setStatus, setTurn } from './status';

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
   * `sendToRenderer('agent-error:…')`, which is a console-level diagnostic
   * stream the renderer's `LogService` already routes to app_logs as a
   * `frontend`-source entry. Both are kept: backend-source rows attribute
   * the error to the session runtime, frontend-source rows attribute it
   * to the renderer code path that observed it.
   */
  logging?: LoggingService | null;
  /**
   * Optional write-through: persists the CLI init-time model catalog for
   * this session's configDir (models service `upsertCatalog`) so the
   * pre-session pickers stay warm without an ephemeral engine spawn.
   */
  modelCatalogSink?: ((configDir: string, models: unknown[]) => void) | null;
  /**
   * Optional identity re-check against the CLI's own init payload. Called with
   * (configDir, observedEmail) on `system:init`. Returns a mismatch to report,
   * or null. Stronger evidence than the pre-flight `.claude.json` read in
   * lifecycle.start(): this is the identity of the process actually running
   * the session, so it catches a stale credential file. See
   * docs/superpowers/specs/2026-07-27-account-email-verification-design.md
   */
  accountMismatchSink?:
    | ((configDir: string, observedEmail: string | null) => AccountMismatch | null)
    | null;
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
  const projectId = encodeProjectId(handle.projectPath);
  const jsonlPath = path.join(
    handle.configDir,
    'projects',
    projectId,
    `${handle.sessionId}.jsonl`,
  );
  state.tail = createJsonlTail({
    jsonlPath,
    // The tail is the transcript source in rich mode, not a supplement to
    // it. stream-json strips `isMeta`, `turnCompanion` and `sourceToolUseID`
    // from the records it carries, and classifiers that needed those fields
    // were reduced to inferring a record's role from its neighbours — which
    // broke the moment the CLI emitted two skill companions instead of one.
    // Reading the file instead means the fields are simply present.
    filter: 'all',
    onMessage: (msg) => {
      // Closure carriers stay on their own channel so that subscription
      // keeps its narrow contract; everything else joins the normal
      // transcript pipeline.
      if (isClosureCarrier(msg)) {
        sendToRenderer(`claude-output-extra:${tabId}`, msg);
        return;
      }
      sendToRenderer(`agent-output:${tabId}`, msg);
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
 * Status transitions (sessionStatus axis only — conversationStatus is now
 * derived by the renderer from JSONL content):
 *  - engine stderr line → NO status change. A non-empty stderr line is surfaced
 *    (toast + app_log) but is NOT treated as session-ending — most CLI stderr is
 *    benign noise (MCP-auth notices, deprecation warnings). The session stays
 *    live. See the engine.onError handler below for the full rationale.
 *  - engine exit    → sessionStatus='stopped' + session removed from the map.
 *    The renderer's next prompt does a fresh start (full --resume) since the
 *    handle is gone.
 *  - sessionStatus='error' is reached only by a failed engine.start()/restart
 *    (a spawn that rejects). While a handle sits in 'error', the next send calls
 *    ensureLiveEngine → restartQuery to transparently respawn it.
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
  // This is the transcript source: every committed row reaches the renderer
  // from here, and stream-json contributes only what the CLI never writes to
  // disk.
  ensureJsonlTail(handle, tabId, jsonlState, sendToRenderer);

  // Pairs each background task's `task_started` with the `task_notification`
  // that ends it, which is the only way to know an AGENT (not a shell) just
  // finished and what it was called. Per-listener, so it dies with the
  // session; losing it costs at most one notification.
  const backgroundTasks = createBackgroundTaskTracker();

  const subscriptions = [
    engine.onMessage((agentMsg: AgentMessage) => {
      const message = agentMsg.payload as Record<string, unknown>;
      const event = classifyRuntimeEvent(message);
      (message as Record<string, unknown>).receivedAt = agentMsg.receivedAt;

      switch (event.kind) {
        case 'init': {
          // The CLI emits `system:init` mid-turn AFTER the first user
          // message, NOT on spawn. By the time this fires, lifecycle has
          // already flipped sessionStatus to 'started'. Only capture catalog
          // data (commands/models/agents/account) that arrives in this payload:
          if (!handle.initData) handle.initData = engine.getInitData();
          const initModels = handle.initData?.models;
          if (deps.modelCatalogSink && Array.isArray(initModels) && initModels.length > 0) {
            try {
              deps.modelCatalogSink(handle.configDir, initModels);
            } catch (err) {
              console.error('[sessions] model catalog write-through failed:', err);
            }
          }
          if (deps.accountMismatchSink) {
            const acct = handle.initData?.account as { email?: unknown } | undefined;
            const observed = typeof acct?.email === 'string' ? acct.email : null;
            try {
              const mismatch = deps.accountMismatchSink(handle.configDir, observed);
              if (mismatch) sendToRenderer(`session-account-mismatch:${tabId}`, mismatch);
            } catch (err) {
              console.error('[sessions] account mismatch re-check failed:', err);
            }
          }
          break;
        }
        case 'rateLimit':
          if (rateLimitHook) {
            try {
              rateLimitHook(handle.configDir, event.info);
            } catch (err) {
              console.error('[sessions] rate-limit hook failed:', err);
            }
          }
          break;
        case 'compact':
        case 'turn':
          break;
        case 'streamEvent':
          break;
        case 'hook':
          // CLI hook lifecycle (hook_started / hook_progress /
          // hook_response / user_prompt_submit). Forward to the renderer
          // for display. No session-status event is emitted — conversationStatus
          // is now derived by the renderer from JSONL content, not from FSM
          // transitions in main.
          break;
        case 'taskStarted':
          backgroundTasks.started(event);
          break;
        case 'taskNotification': {
          // A backgrounded agent finishes long after the `result`
          // notification for the turn that launched it — since CLI
          // >=2.1.232 that turn ends seconds after the launch ACK. Without
          // this the user's only notification arrives while the real work
          // is still running. Shells resolve to null and stay silent.
          const agent = backgroundTasks.resolveAgent(event.taskId);
          if (agent) {
            dispatchAgentNotification({
              tabId,
              projectPath: handle.projectPath,
              description: agent.description,
              event,
              sendToRenderer,
              notificationHooks,
            });
          }
          break;
        }
        case 'result':
          // status flip after notification dispatch below
          break;
      }

      // Transcript inversion: committed rows reach the renderer from the
      // JSONL tail, which carries the fields stream-json strips (`isMeta`,
      // `turnCompanion`, `sourceToolUseID`). Relaying the stream's copy too
      // would render every row twice, so the stream keeps only the shapes
      // the CLI never writes to disk. Note this gates FORWARDING only — the
      // switch above has already acted on the event, and must keep doing so
      // for messages that are not relayed (init's model catalog, the compact
      // hint). See services/sessions/stream-forward.ts.
      if (shouldForwardStreamMessage(message)) {
        sendToRenderer(`agent-output:${tabId}`, message);
      }

      if (event.kind === 'result') {
        dispatchResultNotification({
          tabId,
          projectPath: handle.projectPath,
          event,
          sendToRenderer,
          notificationHooks,
        });
        // The CLI's result row is the turn-closer while the process lives.
        setTurn(handle, 'idle', tabId, sendToRenderer);
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
    // `agent-error:<tabId>` is still emitted so the renderer's LogService
    // captures the stderr line as a frontend-source app_log entry — that's
    // separate from the backend-source app_log we write below, and both
    // serve different attribution lookups in the Log tab.
    engine.onError((err: Error) => {
      if (sessions.get(tabId) !== handle) return;
      const errMsg = err instanceof Error ? err.message : String(err);
      sendToRenderer(`agent-error:${tabId}`, errMsg);
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
      // start() replaced the handle (StrictMode / explicit re-start)?
      // Suppress all renderer-facing events.
      if (sessions.get(tabId) !== handle) {
        teardownJsonlTail(jsonlState);
        for (const s of subscriptions) s.dispose();
        if (exitResolve) exitResolve();
        return;
      }
      setStatus(handle, { sessionStatus: 'stopped' }, tabId, sendToRenderer);
      sendToRenderer(`agent-complete:${tabId}`);
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
 * transcript — a session whose user never sent a message has none.
 */
export function restartQuery(
  tabId: string,
  handle: SessionHandle,
  deps: RuntimeDeps,
): void {
  if (!handle.sessionId) {
    console.error(`[sessions] restartQuery: no sessionId for tab ${tabId}`);
    return;
  }
  const resume = hasTranscript(
    handle.startParams.configDir,
    handle.startParams.projectPath,
    handle.sessionId,
  );
  setStatus(handle, { sessionStatus: 'starting' }, tabId, deps.sendToRenderer);
  void handle.engine.start({
    projectPath: handle.startParams.projectPath,
    configDir: handle.startParams.configDir,
    model: handle.startParams.model,
    permissionMode: handle.startParams.permissionMode,
    sessionId: handle.sessionId,
    resume,
  }).then(() => {
    setStatus(handle, { sessionStatus: 'started' }, tabId, deps.sendToRenderer);
  }).catch((err: unknown) => {
    console.error(`[sessions] engine.start (restart) failed for tab ${tabId}:`, err);
    setStatus(handle, { sessionStatus: 'error' }, tabId, deps.sendToRenderer);
  });
}
