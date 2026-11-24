import type {
  SessionHandle,
  SessionStartParams,
  SessionStatus,
  TurnState,
  SessionsService,
  SendToRenderer,
  PermissionDecision,
  LoggingService,
  PersistPermissionRuleFn,
  RateLimitHook,
  AccountMismatch,
  SessionCloseReason,
  SessionClosedHook,
} from './types';
import {
  createPermissionRequestHandler,
  createPermissionCancelHandler,
  respondPermission as respondPermissionImpl,
  answerPendingQuestionInChat,
} from './permissions';
import { createQueryPassthroughs } from './queries';
import { createModInspector, createValidateRunner } from './mods';
import { createSideChatStore, endSideChat } from './side-chat';
import { beginCliProcess, type CliUsageSink } from './cli-usage';
import { createElicitationHandlers, respondToElicitation } from './elicitations';
import { findSystemClaudeBinary, findSystemCodexBinary } from './binary';
import {
  listenToMessages,
  restartQuery,
  type RuntimeDeps,
} from './runtime';
import { hasTranscript } from '../../session-jsonl-path';
import { shouldAutoTitle, autoTitleDescription } from './auto-title';
import { createClaudeCliEngine } from '../agents/claude-cli-engine';
import { createCodexCliEngine } from '../agents/codex-cli-engine';
import type { AgentEngine, AgentKind, ElicitationAction } from '../agents/types';
import { randomUUID } from 'node:crypto';
import { setStatus, setTurn } from './status';
import { IDLE_TURN } from './types';
import { createAutoRecap, type AutoRecapPolicy } from './auto-recap';
import { dispatchModNotificationRemoval } from './notifications';


export function createSessionsService(
  sendToRenderer: SendToRenderer,
  logging: LoggingService | null = null,
  persistPermissionRule: PersistPermissionRuleFn | null = null,
  rateLimitHook: RateLimitHook | null = null,
  onSessionClosed: SessionClosedHook | null = null,
  resolveAccountConfigDir: ((projectPath: string) => string | null) | null = null,
  modelCatalogSink: ((configDir: string, models: unknown[]) => void) | null = null,
  // MUST be cheap: it runs on every cold start, so never a CLI spawn.
  verifyAccountIdentity: ((configDir: string) => AccountMismatch | null) | null = null,
  accountMismatchSink:
    | ((configDir: string, observedEmail: string | null) => AccountMismatch | null)
    | null = null,
  _extraSpawnArgs: ((configDir: string) => string[]) | null = null,
  resolveClaudeBinary: (() => string | null) | null = null,
  cliUsageSink: CliUsageSink | null = null,
  autoRecapPolicy: (() => AutoRecapPolicy) | null = null,
  modNotificationsEnabled: (() => boolean) | null = null,
): SessionsService {
  const sessions = new Map<string, SessionHandle>();
  const queryPassthroughs = createQueryPassthroughs(
    sessions,
    sendToRenderer,
    logging,
    cliUsageSink,
    createModInspector({ run: createValidateRunner(() => (resolveClaudeBinary ?? findSystemClaudeBinary)()) }),
  );
  const autoRecap = autoRecapPolicy
    ? createAutoRecap({
        policy: autoRecapPolicy,
        canSend: (tabId) => {
          const h = sessions.get(tabId);
          return !!h && h.agent === 'claude' && h.sessionStatus === 'started'
            && h.turn.status === 'idle' && h.permissionQueue.length === 0
            && (h.openBackgroundTasks?.() ?? 0) === 0;
        },
        send: (tabId) => deliverMessage(tabId, '/recap'),
      })
    : null;

  const runtimeDeps: RuntimeDeps = {
    sendToRenderer,
    rateLimitHook,
    sessions,
    logging,
    modelCatalogSink,
    accountMismatchSink,
    cliUsageSink,
    modNotificationsEnabled,
  };

  function start(params: SessionStartParams): void | Promise<void> {
    const { tabId, projectPath } = params;

    // Never re-resolve a resume: its id is tied to the owning account's JSONL. An explicit override also wins.
    let configDir = params.configDir;
    const shouldReResolve =
      !params.resumeSessionId &&
      !params.manualAccountOverride &&
      resolveAccountConfigDir !== null;
    if (shouldReResolve) {
      const resolved = resolveAccountConfigDir(projectPath);
      if (resolved) {
        if (resolved !== configDir && logging) {
          logging.writeBatch([{
            timestamp: new Date().toISOString(),
            level: 'info',
            source: 'backend',
            category: `session:${tabId}`,
            message: `re-resolved configDir on start: renderer=${configDir} → main=${resolved}`,
          }]);
        }
        configDir = resolved;
      }
    }

    // Verify the re-resolved configDir, not the renderer's. Never blocks the start.
    if (verifyAccountIdentity && configDir) {
      try {
        const mismatch = verifyAccountIdentity(configDir);
        if (mismatch) {
          sendToRenderer(`session-account-mismatch:${tabId}`, mismatch);
          logging?.writeBatch([{
            timestamp: new Date().toISOString(),
            level: 'warn',
            source: 'backend',
            category: `session:${tabId}`,
            message:
              `account identity mismatch: expected=${mismatch.expected} ` +
              `detected=${mismatch.detected ?? '(not signed in)'} configDir=${configDir}`,
          }]);
        }
      } catch (err) {
        console.error('[sessions] account identity verification failed:', err);
      }
    }

    const existing = sessions.get(tabId);
    if (existing) {
      endSideChat(existing.sideChat, tabId, sendToRenderer);
      void existing.engine.close().catch(() => { /* ignore */ });
      sessions.delete(tabId);
      queryPassthroughs.evictPluginCache(tabId);
    }

    if (!configDir) {
      throw new Error(`configDir is required to start session for tab ${tabId}`);
    }

    const agent: AgentKind = params.agent ?? 'claude';

    let engine: AgentEngine;
    if (agent === 'codex') {
      const codexPath = findSystemCodexBinary();
      if (!codexPath) {
        sendToRenderer(`session-status:${tabId}`, {
          sessionStatus: 'error',
        });
        sendToRenderer(`agent-error:${tabId}`, 'codex binary not found');
        sendToRenderer(`agent-complete:${tabId}`);
        return;
      }
      engine = createCodexCliEngine({ tabId, codexBinaryPath: codexPath });
    } else {
      const binaryPath = (resolveClaudeBinary ?? findSystemClaudeBinary)();
      if (!binaryPath) {
        sendToRenderer(`session-status:${tabId}`, {
          sessionStatus: 'error',
        });
        sendToRenderer(`agent-error:${tabId}`, 'claude binary not found');
        sendToRenderer(`agent-complete:${tabId}`);
        return;
      }
      engine = createClaudeCliEngine({ tabId, claudeBinaryPath: binaryPath });
    }

    const sessionId = params.resumeSessionId ?? randomUUID();
    // Resume only when the CLI wrote a transcript: `--resume` on an id with none exits at once.
    const resume = !!params.resumeSessionId
      && hasTranscript(configDir, projectPath, sessionId);

    const handle: SessionHandle = {
      agent,
      engine,
      initData: null,
      permissionMode: params.permissionMode,
      startParams: {
        projectPath,
        configDir,
        model: params.model,
        permissionMode: params.permissionMode,
      },
      sessionId,
      sessionStatus: 'started',
      turn: IDLE_TURN,
      turnObserver: autoRecap ? (status) => autoRecap.onTurn(tabId, status) : undefined,
      activityObserver: autoRecap ? () => autoRecap.onActivity(tabId) : undefined,
      permissionResolver: null,
      permissionQueue: [],
      elicitationQueue: [],
      sideChat: createSideChatStore(),
      projectPath,
      configDir,
      autoTitleAttempted: resume,
    };

    sessions.set(tabId, handle);

    // Wire before spawning so the very first message lands somewhere.
    engine.onPermissionRequest(
      createPermissionRequestHandler(handle, tabId, sendToRenderer, logging),
    );
    const elicitations = createElicitationHandlers(handle, tabId, sendToRenderer);
    engine.onElicitationRequest?.(elicitations.onRequest);
    engine.onControlCancel?.(elicitations.onCancel);
    engine.onControlCancel?.(createPermissionCancelHandler(handle, tabId, sendToRenderer));
    listenToMessages(tabId, handle, runtimeDeps).catch((err: unknown) => {
      console.error(`[sessions] Unhandled error in listenToMessages for tab ${tabId}:`, err);
    });

    // Must broadcast before the engine can produce messages.
    sendToRenderer(`session-status:${tabId}`, {
      sessionStatus: 'started',
    });
    sendToRenderer(`session-init:${tabId}`, {
      sessionId,
      projectPath,
    });

    void engine.start({
      projectPath,
      configDir,
      model: params.model,
      permissionMode: params.permissionMode,
      effort: params.effort,
      sessionId,
      resume,
    }).then(async () => {
      if (sessions.get(tabId) !== handle) return;
      if (cliUsageSink) beginCliProcess(handle, cliUsageSink);
      // OmniFex-extended modes (`auto`, `dontAsk`) the CLI's argv parser rejects.
      if (params.permissionMode) {
        await engine.applyExtendedPermissionMode(params.permissionMode);
      }
    }).catch((err: unknown) => {
      if (sessions.get(tabId) !== handle) return;
      setStatus(handle, { sessionStatus: 'error' }, tabId, sendToRenderer);
      const errMsg = err instanceof Error ? err.message : String(err);
      sendToRenderer(`agent-error:${tabId}`, errMsg);
      sendToRenderer(`agent-output:${tabId}`, {
        type: 'system',
        subtype: 'notification',
        notification_type: 'error',
        title: 'Session Error',
        body: `Error: ${errMsg.slice(0, 200)}`,
      });
      sendToRenderer(`agent-complete:${tabId}`);
    });
  }

  function ensureLiveEngine(tabId: string, handle: SessionHandle): void {
    if (handle.sessionStatus === 'error') {
      restartQuery(tabId, handle, runtimeDeps);
    }
  }

  // Auxiliary: must never block the prompt or fail the turn.
  function maybeAutoTitle(tabId: string, handle: SessionHandle, description: string): void {
    if (!shouldAutoTitle({ attempted: handle.autoTitleAttempted, prompt: description })) return;
    handle.autoTitleAttempted = true;
    void handle.engine
      .sendControlRequest('generate_session_title', {
        description: description.trim(),
        persist: true,
      })
      .catch((err: unknown) => {
        console.error(`[sessions] auto-title failed for tab ${tabId}:`, err);
      });
  }

  function sendMessage(tabId: string, prompt: string): void {
    replyToOpenQuestion(tabId);
    const handle = deliverMessage(tabId, prompt);
    if (!handle) return;
    autoRecap?.noteUserSend(tabId);
    personReturned(handle);
    maybeAutoTitle(tabId, handle, prompt);
  }

  // User sends only, never the auto-recap.
  function personReturned(handle: SessionHandle): void {
    if (handle.modNotices) dispatchModNotificationRemoval(handle.modNotices.back(), sendToRenderer);
  }

  // Answer the open question first, or the CLI sits on it with the message queued behind. User sends only, never the auto-recap.
  function replyToOpenQuestion(tabId: string): void {
    const handle = sessions.get(tabId);
    if (handle) answerPendingQuestionInChat(handle, tabId, sendToRenderer);
  }

  function deliverMessage(tabId: string, prompt: string): SessionHandle | null {
    const handle = sessions.get(tabId);
    if (!handle) return null;

    ensureLiveEngine(tabId, handle);

    // Open the turn before the write, so a racing result row cannot be missed.
    setTurn(handle, 'running', tabId, sendToRenderer);
    void handle.engine.send(prompt).catch((err: unknown) => {
      console.error(`[sessions] engine.send failed for tab ${tabId}:`, err);
      setTurn(handle, 'idle', tabId, sendToRenderer);
    });
    return handle;
  }

  function sendStructuredMessage(
    tabId: string,
    content: Record<string, unknown>[],
  ): void {
    const handle = sessions.get(tabId);
    if (!handle) return;

    ensureLiveEngine(tabId, handle);
    replyToOpenQuestion(tabId);

    autoRecap?.noteUserSend(tabId);
    personReturned(handle);
    setTurn(handle, 'running', tabId, sendToRenderer);
    void handle.engine.sendStructured(content).catch((err: unknown) => {
      console.error(`[sessions] engine.sendStructured failed for tab ${tabId}:`, err);
      setTurn(handle, 'idle', tabId, sendToRenderer);
    });
    maybeAutoTitle(tabId, handle, autoTitleDescription(content));
  }

  function respondPermission(
    tabId: string,
    behavior: 'allow' | 'deny',
    updatedInput?: Record<string, unknown>,
    updatedPermissions?: PermissionDecision['updatedPermissions'],
    requestId?: string,
  ): boolean {
    const handle = sessions.get(tabId);
    if (!handle || handle.permissionQueue.length === 0) return false;

    return respondPermissionImpl(
      handle,
      tabId,
      sendToRenderer,
      behavior,
      updatedInput,
      updatedPermissions,
      persistPermissionRule,
      requestId,
    );
  }

  async function respondElicitation(
    tabId: string,
    action: ElicitationAction,
    content?: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) return;
    await respondToElicitation(handle, tabId, sendToRenderer, action, content, requestId);
  }

  function stop(tabId: string, reason: SessionCloseReason = 'closed'): void {
    const handle = sessions.get(tabId);
    if (!handle) return;

    const closedSessionId = handle.sessionId;
    const closedProjectPath = handle.projectPath;
    const closedConfigDir = handle.configDir;

    // Announce before the handle goes, so whoever mirrors the axis learns it.
    setTurn(handle, 'idle', tabId, sendToRenderer);
    autoRecap?.forget(tabId);
    endSideChat(handle.sideChat, tabId, sendToRenderer);
    void handle.engine.close().catch(() => { /* ignore */ });
    sessions.delete(tabId);
    queryPassthroughs.evictPluginCache(tabId);

    if (closedSessionId && closedProjectPath && onSessionClosed) {
      try {
        onSessionClosed(closedSessionId, closedProjectPath, closedConfigDir, reason);
      } catch (err) {
        console.warn('[sessions] onSessionClosed hook threw:', err);
      }
    }
  }

  // Every caller is a process going away, so the close hook must not start work the exit would kill.
  function stopAll(): void {
    for (const tabId of sessions.keys()) {
      stop(tabId, 'shutdown');
    }
  }

  function getSessionId(tabId: string): string | null {
    return sessions.get(tabId)?.sessionId ?? null;
  }

  function getConfigDir(tabId: string): string | null {
    return sessions.get(tabId)?.configDir ?? null;
  }

  function getStatus(tabId: string): { sessionStatus: SessionStatus } {
    const handle = sessions.get(tabId);
    if (!handle) return { sessionStatus: 'stopped' };
    return { sessionStatus: handle.sessionStatus };
  }

  function getInfo(tabId: string): {
    sessionId: string | null;
    sessionStatus: SessionStatus;
  } | null {
    const handle = sessions.get(tabId);
    if (!handle) return null;
    return {
      sessionId: handle.sessionId,
      sessionStatus: handle.sessionStatus,
    };
  }

  function isActive(tabId: string): boolean {
    return sessions.has(tabId);
  }

  function listActiveTabIds(): string[] {
    return Array.from(sessions.keys());
  }

  // The only authority on open sessions: the Brain must not distill a transcript still being written.
  function listActiveSessionIds(): string[] {
    const ids = new Set<string>();
    for (const handle of sessions.values()) {
      if (handle.sessionId) ids.add(handle.sessionId);
    }
    return Array.from(ids);
  }

  function listSessionStatuses(): {
    tabId: string;
    sessionStatus: SessionStatus;
  }[] {
    const out: {
      tabId: string;
      sessionStatus: SessionStatus;
    }[] = [];
    for (const [tabId, handle] of sessions) {
      out.push({
        tabId,
        sessionStatus: handle.sessionStatus,
      });
    }
    return out;
  }

  function getHealth(tabId: string): {
    alive: boolean;
    sessionId: string | null;
    sessionStatus: SessionStatus;
    turn: TurnState;
    launchPermissionMode: string | null;
    permissionMode: string | null;
  } {
    const handle = sessions.get(tabId);
    if (!handle) {
      return { alive: false, sessionId: null, sessionStatus: 'stopped', turn: IDLE_TURN, launchPermissionMode: null, permissionMode: null };
    }
    return {
      alive: true,
      sessionId: handle.sessionId,
      sessionStatus: handle.sessionStatus,
      turn: { ...handle.turn },
      launchPermissionMode: handle.startParams.permissionMode ?? null,
      // A resume spawns from the daemon's persisted options, so the picker reads this back.
      permissionMode: handle.permissionMode || null,
    };
  }

  function getTurn(tabId: string): TurnState {
    const handle = sessions.get(tabId);
    return handle ? { ...handle.turn } : IDLE_TURN;
  }

  return {
    start,
    sendMessage,
    sendStructuredMessage,
    respondPermission,
    respondElicitation,
    stop,
    stopAll,
    getSessionId,
    getConfigDir,
    getStatus,
    getInfo,
    getHealth,
    getTurn,
    isActive,
    listActiveTabIds,
    listActiveSessionIds,
    listSessionStatuses,
    ...queryPassthroughs,
  };
}
