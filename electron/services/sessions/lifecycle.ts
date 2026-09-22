// Sessions module — controller (factory + session management)
//
// Thin glue layer that composes the agent engine (subprocess speaking
// stream-json to `claude`), `runtime.listenToMessages` (the FSM driven by
// engine events), and the per-tab permission-request handler. Holds the
// live `Map<tabId, SessionHandle>` and exposes the public
// `SessionsService` IPC surface.

import type {
  SessionHandle,
  SessionStartParams,
  SessionStatus,
  TurnState,
  SessionsService,
  SendToRenderer,
  NotificationHooks,
  PermissionDecision,
  LoggingService,
  SessionOwnership,
  PersistPermissionRuleFn,
  RateLimitHook,
  ElicitationDecision,
  AccountMismatch,
} from './types';
import {
  createPermissionRequestHandler,
  respondPermission as respondPermissionImpl,
} from './permissions';
import { createQueryPassthroughs } from './queries';
import { findSystemClaudeBinary, findSystemCodexBinary } from './binary';
import {
  listenToMessages,
  restartQuery,
  type RuntimeDeps,
} from './runtime';
import { hasTranscript } from '../project-paths';
import { shouldAutoTitle, autoTitleDescription } from './auto-title';
import { createClaudeCliEngine } from '../agents/claude-cli-engine';
import { createCodexCliEngine } from '../agents/codex-cli-engine';
import type { AgentEngine, AgentKind } from '../agents/types';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setStatus, setTurn } from './status';
import { IDLE_TURN } from './types';


/**
 * Single source of truth for "what sessionId will this session use?" —
 * shared by CLI cold-start and CLI resume so both paths agree on the
 * resolution rule. Resume keeps the caller's id;
 * cold-start mints a fresh UUID synchronously so handle.sessionId is
 * never null after start() returns.
 */
function resolveSessionId(resumeId?: string): string {
  return resumeId ?? randomUUID();
}


// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionsService(
  sendToRenderer: SendToRenderer,
  notificationHooks: NotificationHooks = {},
  logging: LoggingService | null = null,
  ownership: SessionOwnership | null = null,
  persistPermissionRule: PersistPermissionRuleFn | null = null,
  rateLimitHook: RateLimitHook | null = null,
  onSessionClosed: ((sessionId: string, projectPath: string, configDir: string) => void) | null = null,
  /**
   * Optional account resolver. When provided, main re-resolves the configDir
   * for cold-start CLI sessions at the moment of `start()` so a path-rule
   * change between form-mount and Start-click doesn't spawn under a stale
   * account. Skipped for resumes (the resume id is tied to the owning
   * account's JSONL) and when `manualAccountOverride: true` is passed
   * (user explicitly picked an account on the form).
   */
  resolveAccountConfigDir: ((projectPath: string) => string | null) | null = null,
  /**
   * Optional write-through for the CLI init-time model catalog. Called with
   * (configDir, models) when a live session's `system:init` carries a model
   * list; main wires this to the models service's `upsertCatalog` so
   * pre-session pickers stay warm without ephemeral engine spawns.
   */
  modelCatalogSink: ((configDir: string, models: unknown[]) => void) | null = null,
  /**
   * Optional identity verifier. Given the resolved configDir, returns an
   * AccountMismatch when the account's `expected_email` disagrees with whoever
   * is actually authenticated there, or null when it matches / no expectation
   * is set. Injected as a closure so lifecycle keeps no DB dependency.
   *
   * MUST be cheap — this runs on every cold start. main.ts wires it to the
   * `.claude.json` read, never to a CLI spawn. See
   * docs/superpowers/specs/2026-07-27-account-email-verification-design.md
   */
  verifyAccountIdentity: ((configDir: string) => AccountMismatch | null) | null = null,
  /**
   * Optional post-init identity re-check, forwarded to runtime. Compares
   * against the account email the CLI reports in its own `system:init`
   * payload — the identity of the running process, so it catches a stale
   * `.claude.json` that the pre-flight check would have believed.
   */
  accountMismatchSink:
    | ((configDir: string, observedEmail: string | null) => AccountMismatch | null)
    | null = null,
  /**
   * Optional extra CLI arguments for a spawn, derived from its resolved
   * configDir. Returns [] when there is nothing to add.
   *
   * Injected rather than computed here so the session layer keeps no knowledge
   * of the Brain: main.ts is where accounts, vaults and app paths are all in
   * scope, and it is the only place that can map a configDir to a vault
   * without this module growing a dependency on either.
   */
  extraSpawnArgs: ((configDir: string) => string[]) | null = null,
): SessionsService {
  const sessions = new Map<string, SessionHandle>();
  // Hoisted so both the public return and stop()'s plugin-cache eviction
  // share the same instance.
  const queryPassthroughs = createQueryPassthroughs(sessions, sendToRenderer, logging);

  const runtimeDeps: RuntimeDeps = {
    sendToRenderer,
    notificationHooks,
    rateLimitHook,
    ownership,
    sessions,
    logging,
    modelCatalogSink,
    accountMismatchSink,
  };

  // -------------------------------------------------------------------------
  // start()
  // -------------------------------------------------------------------------

  function start(params: SessionStartParams): void | Promise<void> {
    const { tabId, projectPath } = params;

    // Re-resolve the configDir from current account rules so a path-rule
    // change between form-mount and Start-click doesn't spawn under a
    // stale account. Skipped for: (1) resumes — the resume id is tied to
    // a specific account's JSONL, re-routing it would orphan the saved
    // transcript; (2) explicit user overrides — the user deliberately
    // picked a non-rule account on the form; (3) when no resolver was
    // injected — back-compat for unit tests that construct the service
    // bare. See `docs/session-lifecycle.md`.
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

    // Secondary confirmation: is this config dir actually logged in as the
    // account we think it is? Runs against the RE-RESOLVED configDir —
    // checking the renderer-supplied one would verify the wrong account
    // exactly when a path rule just changed. Never blocks: the session
    // starts either way. See
    // docs/superpowers/specs/2026-07-27-account-email-verification-design.md
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

    // Close any existing session for this tab
    const existing = sessions.get(tabId);
    if (existing) {
      void existing.engine.close().catch(() => { /* ignore */ });
      sessions.delete(tabId);
      ownership?.unregister(tabId);
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
      const binaryPath = findSystemClaudeBinary();
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

    // CLI sessions are identified by a UUID pinned at spawn. For cold-start
    // we mint a fresh one; for resume we reuse the caller's id. JSONL path
    // is known up front either way.
    const sessionId = params.resumeSessionId ?? randomUUID();
    // Resume ONLY when the CLI has actually written a transcript for this id.
    //
    // A session's UUID is pinned at spawn and pushed to the renderer via
    // `session-init` immediately, so `claudeSessionId` exists long before any
    // JSONL does. Reconnect and restart both hand that id straight back as
    // `resumeSessionId`. When the user never sent a message there is no
    // transcript, and `--resume` makes the CLI print "No conversation found
    // with session ID …" and exit — the session dies the moment it starts.
    // Keeping the id and spawning with `--session-id` gives the same UUID a
    // fresh transcript, which is what the caller wanted anyway.
    const resume = !!params.resumeSessionId
      && hasTranscript(configDir, projectPath, sessionId);

    // The CLI is ready to accept stdin the moment we spawn it — there is
    // no application-level "ready" handshake in stream-json mode. We
    // construct the handle in the 'started' state from the start; any
    // spawn failure flips us to 'error' via engine.onError / onExit
    // (wired by listenToMessages). This is honest about the CLI's actual
    // model and unblocks the renderer immediately so `agent-output:`
    // events have a place to land.
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
      permissionResolver: null,
      permissionQueue: [],
      elicitationResolver: null,
      projectPath,
      configDir,
      // A resumed conversation is never auto-named: it either already carries
      // a title or predates the CLI's naming gap, and a name derived from a
      // prompt landing mid-conversation is worse than none. See auto-title.ts.
      autoTitleAttempted: resume,
    };

    sessions.set(tabId, handle);
    // Register tab ownership BEFORE any message can route through
    // `agent-output:<tabId>` — without this the routing table drops
    // tab-scoped events on the floor.
    if (params.ownerWebContentsId !== undefined) {
      ownership?.register(tabId, params.ownerWebContentsId);
    }

    // Wire permission-request handler + runtime message subscribers
    // before spawning so the very first message lands somewhere.
    engine.onPermissionRequest(
      createPermissionRequestHandler(handle, tabId, sendToRenderer, notificationHooks, logging),
    );
    listenToMessages(tabId, handle, runtimeDeps).catch((err: unknown) => {
      console.error(`[sessions] Unhandled error in listenToMessages for tab ${tabId}:`, err);
    });

    // Tell the renderer we're live. This must broadcast BEFORE the engine
    // can produce messages so the renderer's session state is in
    // 'started' when agent-output:<tabId> events arrive.
    sendToRenderer(`session-status:${tabId}`, {
      sessionStatus: 'started',
    });
    // Push the pinned sessionId immediately so the renderer can seed
    // claudeSessionId without waiting for the CLI's `system:init` (which
    // only arrives mid-first-turn in stream-json mode). Anything the UI
    // gates on claudeSessionId — mode toggle, model picker, persistence —
    // becomes interactive the moment the user clicks Start.
    sendToRenderer(`session-init:${tabId}`, {
      sessionId,
      projectPath,
    });

    // Spawn the CLI. Fire-and-forget — failures route through engine.onError
    // and engine.onExit, which the runtime translates into sessionStatus
    // transitions + error notifications.
    void engine.start({
      projectPath,
      configDir,
      model: params.model,
      permissionMode: params.permissionMode,
      sessionId,
      resume,
    }).then(async () => {
      if (sessions.get(tabId) !== handle) return;
      // Apply OmniFex-extended permission modes ('auto', 'dontAsk') the
      // CLI's argv parser doesn't accept. No-op for argv-valid modes.
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

  // -------------------------------------------------------------------------
  // sendMessage() / sendStructuredMessage()
  // -------------------------------------------------------------------------

  function ensureLiveEngine(tabId: string, handle: SessionHandle): void {
    // If the previous stream errored, restart the engine transparently.
    if (handle.sessionStatus === 'error') {
      restartQuery(tabId, handle, runtimeDeps);
    }
  }

  /**
   * Ask the CLI to name the session from its first prompt, fire-and-forget.
   *
   * Sent alongside the prompt rather than after the turn: the tab label's job
   * is telling open tabs apart WHILE the turn runs, and a name that arrives
   * five minutes in has missed it. `persist: true` makes the CLI write the
   * `ai-title` record itself, so `extractSessionMetadata` and the tab subtitle
   * pick it up with no further plumbing. Auxiliary work — it must never block
   * the prompt or fail the turn.
   */
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
    const handle = sessions.get(tabId);
    if (!handle) return;

    ensureLiveEngine(tabId, handle);

    // The turn opens the moment the prompt is handed over, before the write,
    // so a result row that races back cannot be missed.
    setTurn(handle, 'running', tabId, sendToRenderer);
    void handle.engine.send(prompt).catch((err: unknown) => {
      console.error(`[sessions] engine.send failed for tab ${tabId}:`, err);
      // The prompt never reached the CLI, so there is no turn to wait on.
      setTurn(handle, 'idle', tabId, sendToRenderer);
    });
    maybeAutoTitle(tabId, handle, prompt);
  }

  function sendStructuredMessage(
    tabId: string,
    content: Record<string, unknown>[],
  ): void {
    const handle = sessions.get(tabId);
    if (!handle) return;

    ensureLiveEngine(tabId, handle);

    setTurn(handle, 'running', tabId, sendToRenderer);
    void handle.engine.sendStructured(content).catch((err: unknown) => {
      console.error(`[sessions] engine.sendStructured failed for tab ${tabId}:`, err);
      setTurn(handle, 'idle', tabId, sendToRenderer);
    });
    maybeAutoTitle(tabId, handle, autoTitleDescription(content));
  }

  // -------------------------------------------------------------------------
  // rebind()
  // -------------------------------------------------------------------------

  function rebind(tabId: string, ownerWebContentsId: number): boolean {
    const handle = sessions.get(tabId);
    if (!handle) return false;
    ownership?.register(tabId, ownerWebContentsId);
    return true;
  }

  // -------------------------------------------------------------------------
  // respondPermission()
  // -------------------------------------------------------------------------

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
      notificationHooks,
      behavior,
      updatedInput,
      updatedPermissions,
      persistPermissionRule,
      requestId,
    );
  }

  // -------------------------------------------------------------------------
  // respondElicitation()
  // -------------------------------------------------------------------------

  function respondElicitation(
    tabId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
  ): void {
    const handle = sessions.get(tabId);
    if (!handle?.elicitationResolver) return;
    handle.elicitationResolver({ action, content });
  }

  // -------------------------------------------------------------------------
  // stop() / stopAll()
  // -------------------------------------------------------------------------

  function stop(tabId: string): void {
    const handle = sessions.get(tabId);
    if (!handle) return;

    // Capture identity before teardown so the close hook still fires for
    // sessions that have a known sessionId (UUID).
    const closedSessionId = handle.sessionId;
    const closedProjectPath = handle.projectPath;
    const closedConfigDir = handle.configDir;

    // A stopped session is not working on anything. Announce before the
    // handle goes, so whoever mirrors the axis learns it.
    setTurn(handle, 'idle', tabId, sendToRenderer);
    void handle.engine.close().catch(() => { /* ignore */ });
    sessions.delete(tabId);
    ownership?.unregister(tabId);
    // Evict the per-tab plugin cache so closed-tab entries don't accumulate
    // over the lifetime of the service.
    queryPassthroughs.evictPluginCache(tabId);

    if (closedSessionId && closedProjectPath && onSessionClosed) {
      // Fire-and-forget — auto-on-close summarization shouldn't block
      // session teardown, and any errors are logged inside the hook.
      try {
        onSessionClosed(closedSessionId, closedProjectPath, closedConfigDir);
      } catch (err) {
        console.warn('[sessions] onSessionClosed hook threw:', err);
      }
    }
  }

  function stopAll(): void {
    for (const tabId of sessions.keys()) {
      stop(tabId);
    }
  }

  // -------------------------------------------------------------------------
  // Query helpers
  // -------------------------------------------------------------------------

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

  /**
   * The session UUIDs of every open session, deduplicated.
   *
   * The join lives here rather than in each caller: this map is the only
   * authority on which conversations are still being written to, and the Brain
   * needs exactly that set — a transcript whose session is still open would be
   * distilled half-finished and then recorded as done.
   *
   * Handles with no UUID yet (a cold start that has not minted one) contribute
   * nothing; there is no transcript on disk to protect yet either.
   */
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
  } {
    const handle = sessions.get(tabId);
    if (!handle) {
      return { alive: false, sessionId: null, sessionStatus: 'stopped', turn: IDLE_TURN };
    }
    return {
      alive: true,
      sessionId: handle.sessionId,
      sessionStatus: handle.sessionStatus,
      turn: { ...handle.turn },
    };
  }

  function getTurn(tabId: string): TurnState {
    const handle = sessions.get(tabId);
    return handle ? { ...handle.turn } : IDLE_TURN;
  }

  // -------------------------------------------------------------------------
  // Return service
  // -------------------------------------------------------------------------

  return {
    start,
    rebind,
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
