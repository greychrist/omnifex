import path from 'node:path';
import type {
  SessionHandle,
  SendToRenderer,
  RateLimitHook,
  LoggingService,
  AccountMismatch,
} from './types';
import type { AgentMessage } from '../agents/types';
import { classifyRuntimeEvent } from './events';
import {
  dispatchAgentNotification,
  dispatchModNotification,
  dispatchModNotificationRemoval,
  dispatchResultNotification,
} from './notifications';
import { createModNoticeTracker } from './mod-notifications';
import { createBackgroundTaskTracker } from './background-tasks';
import { createJsonlTail, isClosureCarrier, type JsonlTailHandle } from './jsonl-tail';
import { shouldForwardStreamMessage } from './stream-forward';
import { encodeProjectId } from '../project-paths';
import { findSessionJsonlInAccount, hasTranscript } from '../../session-jsonl-path';
import { setStatus, setTurn } from './status';
import { endSideChat } from './side-chat';
import { beginCliProcess, recordResultUsage, type CliUsageSink } from './cli-usage';

export interface RuntimeDeps {
  sendToRenderer: SendToRenderer;
  rateLimitHook: RateLimitHook | null;
  // Identity-checked (`sessions.get(tabId) !== handle`) to skip cleanup once start() has replaced the handle.
  sessions: Map<string, SessionHandle>;
  logging?: LoggingService | null;
  modelCatalogSink?: ((configDir: string, models: unknown[]) => void) | null;
  // The running process's identity: catches a stale `.claude.json` the pre-flight check believed.
  accountMismatchSink?:
    | ((configDir: string, observedEmail: string | null) => AccountMismatch | null)
    | null;
  cliUsageSink?: CliUsageSink | null;
  // Cancels pass regardless, so turning it off never strands a booked notification.
  modNotificationsEnabled?: (() => boolean) | null;
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
  const sessionId = handle.sessionId;
  if (state.tail || !sessionId) return;
  if (process.env.OMNIFEX_DISABLE_JSONL_TAIL === '1') return;
  const projectId = encodeProjectId(handle.projectPath);
  const jsonlPath = path.join(
    handle.configDir,
    'projects',
    projectId,
    `${sessionId}.jsonl`,
  );
  state.tail = createJsonlTail({
    jsonlPath,
    // The tail is the transcript source: stream-json strips `isMeta`, `turnCompanion` and `sourceToolUseID`.
    filter: 'all',
    // EnterWorktree moves the transcript mid-session; projectPath never changes.
    locate: () => findSessionJsonlInAccount(handle.configDir, sessionId, handle.projectPath),
    onMessage: (msg) => {
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

export function listenToMessages(
  tabId: string,
  handle: SessionHandle,
  deps: RuntimeDeps,
): Promise<void> {
  const { sendToRenderer, rateLimitHook, sessions, logging } = deps;
  const engine = handle.engine;
  if (!engine) return Promise.resolve();

  const jsonlState: JsonlTailState = { tail: null };
  let exitResolve: (() => void) | null = null;
  const done = new Promise<void>((resolve) => { exitResolve = resolve; });

  ensureJsonlTail(handle, tabId, jsonlState, sendToRenderer);

  const backgroundTasks = createBackgroundTaskTracker();
  handle.openBackgroundTasks = () => backgroundTasks.openCount();

  const subscriptions = [
    engine.onMessage((agentMsg: AgentMessage) => {
      const message = agentMsg.payload as Record<string, unknown>;
      const event = classifyRuntimeEvent(message);
      (message).receivedAt = agentMsg.receivedAt;

      if (message.type === 'assistant') {
        const model = (message.message as { model?: unknown } | undefined)?.model;
        if (typeof model === 'string' && model !== '<synthetic>') handle.lastModel = model;
      }

      switch (event.kind) {
        case 'init': {
          // `system:init` arrives mid-first-turn, not on spawn.
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
          break;
        case 'taskStarted':
          backgroundTasks.started(event);
          break;
        case 'taskNotification': {
          backgroundTasks.finished(event.taskId);
          const agent = backgroundTasks.resolveAgent(event.taskId);
          if (agent) {
            dispatchAgentNotification({
              tabId,
              projectPath: handle.projectPath,
              description: agent.description,
              event,
              sendToRenderer,
            });
          }
          break;
        }
        case 'modNotify': {
          if (deps.modNotificationsEnabled && !deps.modNotificationsEnabled()) break;
          const notice = (handle.modNotices ??= createModNoticeTracker()).notify(message);
          if (notice) dispatchModNotification(tabId, notice, sendToRenderer);
          break;
        }
        case 'modNotifyCancel':
          dispatchModNotificationRemoval(
            (handle.modNotices ??= createModNoticeTracker()).cancel(message),
            sendToRenderer,
          );
          break;
        case 'result':
          if (deps.cliUsageSink) recordResultUsage(handle, message, deps.cliUsageSink);
          break;
      }

      // Committed rows come from the JSONL tail; relaying the stream's copy would render each twice.
      // Gates forwarding only: the switch above still acts on every event.
      if (shouldForwardStreamMessage(message)) {
        sendToRenderer(`agent-output:${tabId}`, message);
      }

      if (event.kind === 'result') {
        dispatchResultNotification({
          tabId,
          projectPath: handle.projectPath,
          event,
          sendToRenderer,
        });
        setTurn(handle, 'idle', tabId, sendToRenderer);
      } else {
        handle.activityObserver?.();
      }
    }),

    // A stderr line is not session-ending (most is benign noise): surface it, but never flip to 'error',
    // emit claude-complete, or inject an error card. Only onExit ends the session.
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
      if (sessions.get(tabId) !== handle) {
        teardownJsonlTail(jsonlState);
        for (const s of subscriptions) s.dispose();
        if (exitResolve) exitResolve();
        return;
      }
      setStatus(handle, { sessionStatus: 'stopped' }, tabId, sendToRenderer);
      sendToRenderer(`agent-complete:${tabId}`);
      endSideChat(handle.sideChat, tabId, sendToRenderer);
      sessions.delete(tabId);
      teardownJsonlTail(jsonlState);
      for (const s of subscriptions) s.dispose();
      if (exitResolve) exitResolve();
    }),
  ];

  return done;
}

// `--resume` only when the JSONL exists: the CLI exits on an id with no transcript.
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
    if (deps.cliUsageSink) beginCliProcess(handle, deps.cliUsageSink);
  }).catch((err: unknown) => {
    console.error(`[sessions] engine.start (restart) failed for tab ${tabId}:`, err);
    setStatus(handle, { sessionStatus: 'error' }, tabId, deps.sendToRenderer);
  });
}
