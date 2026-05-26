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
  ConversationStatus,
  SessionMode,
  SessionsService,
  SendToRenderer,
  NotificationHooks,
  PermissionDecision,
  LoggingService,
  SessionOwnership,
  PersistPermissionRuleFn,
  RateLimitHook,
  ElicitationDecision,
} from './types';
import {
  createPermissionRequestHandler,
  respondPermission as respondPermissionImpl,
} from './permissions';
import { createQueryPassthroughs } from './queries';
import { createTuiSession } from './tui';
import { findSystemClaudeBinary } from './binary';
import {
  listenToMessages,
  restartQuery,
  type RuntimeDeps,
} from './runtime';
import { createTuiJsonlListener } from './tui-jsonl';
import { encodeProjectKey } from './summary-query';
import { createClaudeCliEngine } from '../agents/claude-cli-engine';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setStatus } from './status';


/**
 * Single source of truth for "what sessionId will this session use?" —
 * shared by SDK cold-start, SDK resume, and TUI cold-start so all three
 * paths agree on the resolution rule. Resume keeps the caller's id;
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
   * for cold-start SDK sessions at the moment of `start()` so a path-rule
   * change between form-mount and Start-click doesn't spawn under a stale
   * account. Skipped for resumes (the resume id is tied to the owning
   * account's JSONL) and when `manualAccountOverride: true` is passed
   * (user explicitly picked an account on the form).
   */
  resolveAccountConfigDir: ((projectPath: string) => string | null) | null = null,
): SessionsService {
  const sessions = new Map<string, SessionHandle>();
  // Hoisted so both the public return and stop()'s plugin-cache eviction
  // share the same instance.
  const queryPassthroughs = createQueryPassthroughs(sessions, sendToRenderer);

  const runtimeDeps: RuntimeDeps = {
    sendToRenderer,
    notificationHooks,
    rateLimitHook,
    ownership,
    sessions,
    logging,
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

    if (params.mode === 'tui') {
      return startTuiColdStart({ ...params, configDir });
    }

    // Close any existing session for this tab
    const existing = sessions.get(tabId);
    if (existing) {
      existing.tuiJsonl?.stop();
      existing.tuiDetach?.();
      if (existing.engine) { void existing.engine.close().catch(() => { /* ignore */ }); }
      sessions.delete(tabId);
      ownership?.unregister(tabId);
      queryPassthroughs.evictPluginCache(tabId);
    }

    if (!configDir) {
      throw new Error(`configDir is required to start session for tab ${tabId}`);
    }

    const binaryPath = findSystemClaudeBinary();
    if (!binaryPath) {
      sendToRenderer(`session-status:${tabId}`, {
        sessionStatus: 'error',
        conversationStatus: null,
      });
      sendToRenderer(`claude-error:${tabId}`, 'claude binary not found');
      sendToRenderer(`claude-complete:${tabId}`);
      return;
    }

    const engine = createClaudeCliEngine({ tabId, claudeBinaryPath: binaryPath });

    // CLI sessions are identified by a UUID pinned at spawn. For cold-start
    // we mint a fresh one; for resume we reuse the caller's id. JSONL path
    // is known up front either way.
    const sessionId = params.resumeSessionId ?? randomUUID();
    const resume = !!params.resumeSessionId;

    // The CLI is ready to accept stdin the moment we spawn it — there is
    // no application-level "ready" handshake in stream-json mode. We
    // construct the handle in the 'started' state from the start; any
    // spawn failure flips us to 'error' via engine.onError / onExit
    // (wired by listenToMessages). This is honest about the CLI's actual
    // model and unblocks the renderer immediately so `claude-output:`
    // events have a place to land.
    const handle: SessionHandle = {
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
      conversationStatus: 'idle',
      mode: 'rich',
      tui: null,
      tuiDetach: null,
      tuiJsonl: null,
      permissionResolver: null,
      permissionQueue: [],
      elicitationResolver: null,
      projectPath,
      configDir,
    };

    sessions.set(tabId, handle);
    // Register tab ownership BEFORE any message can route through
    // `claude-output:<tabId>` — without this the routing table drops
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
    // 'started' when claude-output:<tabId> events arrive.
    sendToRenderer(`session-status:${tabId}`, {
      sessionStatus: 'started',
      conversationStatus: 'idle',
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
      sendToRenderer(`claude-error:${tabId}`, errMsg);
      sendToRenderer(`claude-output:${tabId}`, {
        type: 'system',
        subtype: 'notification',
        notification_type: 'error',
        title: 'Session Error',
        body: `Error: ${errMsg.slice(0, 200)}`,
      });
      sendToRenderer(`claude-complete:${tabId}`);
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

  function sendMessage(tabId: string, prompt: string): void {
    const handle = sessions.get(tabId);
    if (!handle) return;
    if (!handle.engine) return; // TUI cold-start — input goes through PTY
    if (handle.mode === 'tui') return;

    ensureLiveEngine(tabId, handle);

    // Mark the conversation as in-flight before the engine echoes anything
    // back, so the in-flight gate reacts to the user's submit immediately.
    setStatus(handle, { conversationStatus: 'running' }, tabId, sendToRenderer);

    void handle.engine.send(prompt).catch((err: unknown) => {
      console.error(`[sessions] engine.send failed for tab ${tabId}:`, err);
    });
  }

  function sendStructuredMessage(
    tabId: string,
    content: Record<string, unknown>[],
  ): void {
    const handle = sessions.get(tabId);
    if (!handle) return;
    if (!handle.engine) return;
    if (handle.mode === 'tui') return;

    ensureLiveEngine(tabId, handle);

    setStatus(handle, { conversationStatus: 'running' }, tabId, sendToRenderer);

    void handle.engine.sendStructured(content).catch((err: unknown) => {
      console.error(`[sessions] engine.sendStructured failed for tab ${tabId}:`, err);
    });
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
  ): void {
    const handle = sessions.get(tabId);
    if (!handle || handle.permissionQueue.length === 0) return;

    respondPermissionImpl(
      handle,
      tabId,
      sendToRenderer,
      notificationHooks,
      behavior,
      updatedInput,
      updatedPermissions,
      persistPermissionRule,
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

    handle.tuiJsonl?.stop();
    handle.tuiDetach?.();
    if (handle.engine) {
      void handle.engine.close().catch(() => { /* ignore */ });
    }
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

  function getStatus(tabId: string): { sessionStatus: SessionStatus; conversationStatus: ConversationStatus | null } {
    const handle = sessions.get(tabId);
    if (!handle) return { sessionStatus: 'stopped', conversationStatus: null };
    return { sessionStatus: handle.sessionStatus, conversationStatus: handle.conversationStatus };
  }

  function getInfo(tabId: string): {
    sessionId: string | null;
    sessionStatus: SessionStatus;
    conversationStatus: ConversationStatus | null;
  } | null {
    const handle = sessions.get(tabId);
    if (!handle) return null;
    return {
      sessionId: handle.sessionId,
      sessionStatus: handle.sessionStatus,
      conversationStatus: handle.conversationStatus,
    };
  }

  function isActive(tabId: string): boolean {
    return sessions.has(tabId);
  }

  function listActiveTabIds(): string[] {
    return Array.from(sessions.keys());
  }

  // In-flight = conversationStatus is non-null and non-idle. See
  // docs/session-lifecycle.md — sessionStatus='starting'/'error'/'stopped'
  // do NOT count; only a conversation that's actually mid-turn or paused
  // on a permission prompt blocks the installer's wait-for-idle gate.
  function listInFlightTabIds(): string[] {
    const ids: string[] = [];
    for (const [tabId, handle] of sessions) {
      if (
        handle.conversationStatus !== null &&
        handle.conversationStatus !== 'idle'
      ) {
        ids.push(tabId);
      }
    }
    return ids;
  }

  function listSessionStatuses(): {
    tabId: string;
    sessionStatus: SessionStatus;
    conversationStatus: ConversationStatus | null;
  }[] {
    const out: {
      tabId: string;
      sessionStatus: SessionStatus;
      conversationStatus: ConversationStatus | null;
    }[] = [];
    for (const [tabId, handle] of sessions) {
      out.push({
        tabId,
        sessionStatus: handle.sessionStatus,
        conversationStatus: handle.conversationStatus,
      });
    }
    return out;
  }

  function getHealth(tabId: string): {
    alive: boolean;
    sessionId: string | null;
    sessionStatus: SessionStatus;
    conversationStatus: ConversationStatus | null;
  } {
    const handle = sessions.get(tabId);
    if (!handle) {
      return { alive: false, sessionId: null, sessionStatus: 'stopped', conversationStatus: null };
    }
    return {
      alive: true,
      sessionId: handle.sessionId,
      sessionStatus: handle.sessionStatus,
      conversationStatus: handle.conversationStatus,
    };
  }

  async function setMode(tabId: string, mode: SessionMode): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) throw new Error(`setMode: unknown tab ${tabId}`);
    if (handle.mode === mode) return;

    // Gate: allow switching while the SDK is mid-turn or idle on a
    // started session, or in the transient 'starting' state (post-
    // restart, before the first message arrives). Block when paused on
    // a permission prompt or the session is dead.
    const conn = handle.sessionStatus;
    const conv = handle.conversationStatus;
    const allowed =
      conn === 'starting' ||
      (conn === 'started' && (conv === 'idle' || conv === 'running'));
    if (!allowed) {
      throw new Error(
        `setMode: not allowed while sessionStatus="${conn}" conversationStatus="${conv ?? 'null'}"`,
      );
    }

    if (mode === 'tui') {
      if (!handle.sessionId) {
        throw new Error('setMode("tui"): session has no sessionId yet');
      }

      const binaryPath = findSystemClaudeBinary();
      if (!binaryPath) throw new Error('setMode("tui"): claude binary not found');

      // Mark as tui BEFORE closing the engine so that the runtime's
      // cleanup guard sees mode === 'tui' and skips the session deletion.
      handle.mode = 'tui';

      // Close the engine cleanly.
      if (handle.engine) {
        try { await handle.engine.close(); } catch { /* best effort */ }
      }

      // If the user toggles to TUI before any messages were sent in rich
      // mode, the CLI hasn't written a JSONL for this sessionId yet. Passing
      // `--resume <id>` in that case makes the CLI emit
      // "No conversation found with session ID …" and exit, which then
      // boots the user out of the session via the TUI exit handler below.
      // Detect the JSONL's absence and pin the existing sessionId via
      // `--session-id <id>` instead — same UUID, fresh transcript, no error.
      const jsonlPathForResumeCheck = path.join(
        handle.configDir,
        'projects',
        encodeProjectKey(handle.projectPath),
        `${handle.sessionId}.jsonl`,
      );
      const resumeExistingTranscript = fs.existsSync(jsonlPathForResumeCheck);

      const tui = createTuiSession({
        tabId,
        projectPath: handle.projectPath,
        configDir: handle.configDir,
        sessionId: handle.sessionId,
        resume: resumeExistingTranscript,
        claudeBinaryPath: binaryPath,
      });

      tui.onData((data: string) => sendToRenderer(`session-tui-data:${tabId}`, data));
      tui.onExit((r: { exitCode: number }) => {
        sendToRenderer(`session-tui-exit:${tabId}`, r);
        handle.tuiJsonl?.stop();
        handle.tuiJsonl = null;
        // Auto-revert to rich mode.
        void setMode(tabId, 'rich').catch((e: unknown) =>
          console.error('[sessions] auto-revert to rich failed:', e)
        );
      });

      handle.tui = tui;
      handle.tuiDetach = () => { try { tui.kill(); } catch { /* best effort */ } };
      sendToRenderer(`session-mode:${tabId}`, { mode: 'tui' });

      // Wire up the JSONL listener so mid-session toggle gets the same
      // message rendering and status tracking as cold-start TUI mode.
      const jsonlPath = path.join(
        handle.configDir,
        'projects',
        encodeProjectKey(handle.projectPath),
        `${handle.sessionId}.jsonl`,
      );
      handle.tuiJsonl = createTuiJsonlListener({
        tabId,
        projectPath: handle.projectPath,
        jsonlPath,
        sendToRenderer,
        notificationHooks,
        onInit: () => {
          // sessionId is already known (precondition for the toggle); ignore.
        },
        onStatusChange: (status) => {
          // TUI JSONL reports turn-level idle/running. Connection is
          // already 'started' for a mid-session toggle, so we just need
          // to update conversationStatus.
          setStatus(handle, { sessionStatus: 'started', conversationStatus: status }, tabId, sendToRenderer);
        },
      });
    } else {
      // tui -> rich: kill the pty, then re-start the engine with --resume.
      handle.tuiJsonl?.stop();
      handle.tuiJsonl = null;
      handle.tuiDetach?.();
      handle.tui = null;
      handle.tuiDetach = null;
      handle.mode = 'rich';
      sendToRenderer(`session-mode:${tabId}`, { mode: 'rich' });

      // Re-start the engine on the same session id. start() is re-entrant.
      if (!handle.engine) {
        // Cold-start TUI sessions never had an engine. Build one now.
        const binaryPath = findSystemClaudeBinary();
        if (!binaryPath) throw new Error('setMode("rich"): claude binary not found');
        handle.engine = createClaudeCliEngine({ tabId, claudeBinaryPath: binaryPath });
        handle.engine.onPermissionRequest(
          createPermissionRequestHandler(handle, tabId, sendToRenderer, notificationHooks, logging),
        );
        listenToMessages(tabId, handle, runtimeDeps).catch((err: unknown) => {
          console.error(`[sessions] Unhandled error in listenToMessages for tab ${tabId}:`, err);
        });
      }
      restartQuery(tabId, handle, runtimeDeps);
    }
  }

  function tuiWrite(tabId: string, data: string): void {
    sessions.get(tabId)?.tui?.write(data);
  }

  function tuiResize(tabId: string, cols: number, rows: number): void {
    sessions.get(tabId)?.tui?.resize(cols, rows);
  }

  function getMode(tabId: string): SessionMode | null {
    return sessions.get(tabId)?.mode ?? null;
  }

  // -------------------------------------------------------------------------
  // startTuiColdStart()
  // -------------------------------------------------------------------------

  async function startTuiColdStart(params: SessionStartParams): Promise<void> {
    const { tabId, projectPath, configDir } = params;
    if (!configDir) throw new Error(`configDir is required to start session for tab ${tabId}`);

    // Close any existing session for this tab
    const existing = sessions.get(tabId);
    if (existing) {
      existing.tuiJsonl?.stop();
      existing.tuiDetach?.();
      if (existing.engine) {
        void existing.engine.close().catch(() => { /* ignore */ });
      }
      sessions.delete(tabId);
      ownership?.unregister(tabId);
      queryPassthroughs.evictPluginCache(tabId);
    }

    const binaryPath = findSystemClaudeBinary();
    if (!binaryPath) throw new Error('startTuiColdStart: claude binary not found');

    // TUI pre-mints the UUID and passes it to the CLI via `--session-id`
    // so the JSONL file path is known up front (no discovery race, no
    // resume-picker dialog). The CLI in pty mode handles `--session-id`
    // cleanly — unlike the SDK's stream-json mode, where pinning makes
    // the CLI suppress init and the control channel. When the caller
    // passes resumeSessionId, reuse it and switch the CLI to `--resume`
    // so the prior conversation continues instead of starting fresh.
    const resuming = !!params.resumeSessionId;
    const sessionId = resolveSessionId(params.resumeSessionId);
    const jsonlPath = path.join(
      configDir,
      'projects',
      encodeProjectKey(projectPath),
      `${sessionId}.jsonl`,
    );

    const handle: SessionHandle = {
      engine: null,
      initData: null,
      permissionMode: params.permissionMode,
      startParams: {
        projectPath,
        configDir,
        model: params.model,
        permissionMode: params.permissionMode,
      },
      sessionId,
      sessionStatus: 'starting',
      conversationStatus: null,
      mode: 'tui',
      tui: null,
      tuiDetach: null,
      tuiJsonl: null,
      permissionResolver: null,
      permissionQueue: [],
      elicitationResolver: null,
      projectPath,
      configDir,
    };
    sessions.set(tabId, handle);
    if (params.ownerWebContentsId !== undefined) {
      ownership?.register(tabId, params.ownerWebContentsId);
    }

    const tui = createTuiSession({
      tabId,
      projectPath,
      configDir,
      sessionId,
      // resume=true → CLI spawns with `--resume <id>` (continues prior turns).
      // resume=false → CLI spawns with `--session-id <id>` (fresh session
      // with a caller-chosen UUID so the JSONL path is known up front).
      resume: resuming,
      claudeBinaryPath: binaryPath,
    });

    tui.onData((data: string) => sendToRenderer(`session-tui-data:${tabId}`, data));
    tui.onExit((r: { exitCode: number }) => {
      sendToRenderer(`session-tui-exit:${tabId}`, r);
      handle.tuiJsonl?.stop();
      handle.tuiJsonl = null;
      setStatus(handle, { sessionStatus: 'stopped' }, tabId, sendToRenderer);
      sendToRenderer(`claude-complete:${tabId}`);
      // Only mutate the shared map if we are still the current session for this tab.
      // A `stop()` followed by a new `start()` on the same tabId will have already
      // registered a different handle; deleting here would orphan it.
      if (sessions.get(tabId) === handle) {
        sessions.delete(tabId);
        ownership?.unregister(tabId);
      }
    });

    handle.tui = tui;
    handle.tuiDetach = () => { try { tui.kill(); } catch { /* ignore */ } };

    // Attach the JSONL listener immediately. `createJsonlTail` handles the
    // ENOENT case — it polls until the CLI creates the file, then starts
    // forwarding lines. No race, no timeout.
    handle.tuiJsonl = createTuiJsonlListener({
      tabId,
      projectPath,
      jsonlPath,
      sendToRenderer,
      notificationHooks,
      onInit: () => {
        // sessionId is already set on the handle; ignore CLI re-inits.
      },
      onStatusChange: (status) => {
        // First JSONL line means the CLI has spun up — sessionStatus
        // flips to 'started' here; subsequent calls just update the
        // conversation axis.
        setStatus(handle, { sessionStatus: 'started', conversationStatus: status }, tabId, sendToRenderer);
      },
    });

    // TUI cold-start: handle is up, CLI is being spawned, JSONL listener
    // attached. Once the CLI writes its first JSONL line, the listener's
    // onStatusChange will flip us to started+idle/running. For now we're
    // still 'starting' with no conversation.
    sendToRenderer(`session-status:${tabId}`, {
      sessionStatus: 'starting',
      conversationStatus: null,
    });
    sendToRenderer(`session-mode:${tabId}`, { mode: 'tui' });
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
    isActive,
    listActiveTabIds,
    listInFlightTabIds,
    listSessionStatuses,
    setMode,
    tuiWrite,
    tuiResize,
    getMode,
    ...queryPassthroughs,
  };
}
