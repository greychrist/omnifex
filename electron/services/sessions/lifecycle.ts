// Sessions module — controller (factory + session management)
//
// Thin glue layer that composes `factory.buildSdkOptions` (SDK options
// assembly), `runtime.listenToMessages` / `runtime.restartQuery` (the
// stream FSM), and the per-tab `permissions.canUseTool` callback.
// Holds the live `Map<tabId, SessionHandle>` and exposes the public
// `SessionsService` IPC surface.

import { createAsyncChannel } from '../async-channel';
import { startup } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
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
  createCanUseTool,
  respondPermission as respondPermissionImpl,
} from './permissions';
import { createQueryPassthroughs } from './queries';
import { createTuiSession } from './tui';
import { buildSdkOptions, findSystemClaudeBinary } from './factory';
import {
  listenToMessages,
  restartQuery,
  type RuntimeDeps,
} from './runtime';
import { createTuiJsonlListener } from './tui-jsonl';
import { encodeProjectKey } from './summary-query';
import path from 'node:path';
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

function initMessageFromControlResponse(
  init: Record<string, unknown>,
  fallback: {
    projectPath: string;
    model: string;
    permissionMode: string;
  },
): Record<string, unknown> {
  const commands = Array.isArray(init.commands)
    ? init.commands
      .map((cmd) => typeof cmd === 'object' && cmd !== null && 'name' in cmd
        ? (cmd as { name?: unknown }).name
        : null)
      .filter((name): name is string => typeof name === 'string')
    : [];
  const agents = Array.isArray(init.agents)
    ? init.agents
      .map((agent) => typeof agent === 'object' && agent !== null && 'name' in agent
        ? (agent as { name?: unknown }).name
        : null)
      .filter((name): name is string => typeof name === 'string')
    : [];

  return {
    type: 'system',
    subtype: 'init',
    session_id: typeof init.session_id === 'string'
      ? init.session_id
      : typeof init.uuid === 'string'
        ? init.uuid
        : '',
    cwd: typeof init.cwd === 'string' ? init.cwd : fallback.projectPath,
    model: typeof init.model === 'string' ? init.model : fallback.model,
    permissionMode: typeof init.permissionMode === 'string'
      ? init.permissionMode
      : fallback.permissionMode,
    tools: Array.isArray(init.tools) ? init.tools : [],
    mcp_servers: Array.isArray(init.mcp_servers) ? init.mcp_servers : [],
    slash_commands: commands,
    agents,
    output_style: typeof init.output_style === 'string' ? init.output_style : undefined,
    skills: Array.isArray(init.skills) ? init.skills : [],
    plugins: Array.isArray(init.plugins) ? init.plugins : [],
  };
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
      if (existing.inputChannel) existing.inputChannel.close();
      if (existing.query) { try { existing.query.close(); } catch { /* ignore */ } }
      sessions.delete(tabId);
      ownership?.unregister(tabId);
      queryPassthroughs.evictPluginCache(tabId);
    }

    const inputChannel = createAsyncChannel<SDKUserMessage>(1000);

    // Build the SDK options. The factory excludes `canUseTool` because
    // that callback closes over the handle (which is created below).
    const options = buildSdkOptions(params, {
      tabId,
      sendToRenderer,
      logging,
      onElicitationRequest: (_request) =>
        new Promise<ElicitationDecision>((resolve) => {
          handle.elicitationResolver = (decision) => {
            handle.elicitationResolver = null;
            resolve(decision);
          };
        }),
    });

    // sessionId starts null for cold-start (set on the SDK's first init)
    // and seeded from resumeSessionId for resume (so consumers like
    // setMode('tui') don't have to wait for the init echo).
    const handle: SessionHandle = {
      query: null, // set below
      inputChannel,
      sessionId: params.resumeSessionId ?? null,
      sessionStatus: 'starting',
      conversationStatus: null,
      mode: 'sdk',
      tui: null,
      tuiDetach: null,
      tuiJsonl: null,
      permissionResolver: null,
      permissionQueue: [],
      elicitationResolver: null,
      projectPath,
      configDir: (() => {
        if (!configDir) throw new Error(`configDir is required to start session for tab ${tabId}`);
        return configDir;
      })(),
      sdkOptions: options,
    };

    options.canUseTool = createCanUseTool(handle, tabId, sendToRenderer, notificationHooks, logging);

    sessions.set(tabId, handle);
    if (params.ownerWebContentsId !== undefined) {
      ownership?.register(tabId, params.ownerWebContentsId);
    }

    // Tell the renderer we're in 'starting' — handle was just created,
    // SDK has not emitted anything yet. The runtime will transition to
    // sessionStatus='started' + conversationStatus='idle' on the first
    // system:init. conversationStatus is null until then per the model.
    sendToRenderer(`session-status:${tabId}`, {
      sessionStatus: 'starting',
      conversationStatus: null,
    });

    void startup({ options }).then((warmQuery) => {
      if (sessions.get(tabId) !== handle || handle.inputChannel !== inputChannel) {
        try {
          warmQuery.close();
        } catch {
          /* ignore */
        }
        return;
      }

      const q = warmQuery.query(inputChannel);
      handle.query = q;
      if (typeof q.initializationResult === 'function') {
        void q.initializationResult().then((init) => {
          if (sessions.get(tabId) !== handle) return;
          const initMessage = initMessageFromControlResponse(init as Record<string, unknown>, {
            projectPath,
            model: params.model,
            permissionMode: params.permissionMode,
          });
          const sid = typeof initMessage.session_id === 'string' ? initMessage.session_id : '';
          if (sid) handle.sessionId = sid;
          setStatus(handle, { sessionStatus: 'started', conversationStatus: 'idle' }, tabId, sendToRenderer);
          sendToRenderer(`claude-output:${tabId}`, {
            ...initMessage,
            receivedAt: new Date().toISOString(),
          });
        }).catch((err: unknown) => {
          if (sessions.get(tabId) !== handle) return;
          console.warn('[sessions] initializationResult after startup failed:', err);
        });
      }
      listenToMessages(tabId, handle, runtimeDeps).catch((err: unknown) => {
        console.error(`[sessions] Unhandled error in listenToMessages for tab ${tabId}:`, err);
      });
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

  function ensureLiveQuery(tabId: string, handle: SessionHandle): void {
    // If the previous stream errored, restart the SDK query transparently
    if (handle.sessionStatus === 'error') {
      restartQuery(tabId, handle, runtimeDeps);
    }
  }

  function sendMessage(tabId: string, prompt: string): void {
    const handle = sessions.get(tabId);
    if (!handle) return;
    if (!handle.inputChannel) return; // TUI mode — input goes through PTY

    if (handle.query) {
      ensureLiveQuery(tabId, handle);
    }

    // Mark the conversation as in-flight before the SDK has a chance to
    // echo anything back, so the in-flight gate reacts to the user's
    // submit immediately. The user only sends messages on a 'started'
    // session, so this transition is safe.
    setStatus(handle, { conversationStatus: 'running' }, tabId, sendToRenderer);

    const message: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: prompt,
      },
      parent_tool_use_id: null,
    };

    handle.inputChannel.push(message);
  }

  function sendStructuredMessage(
    tabId: string,
    content: Record<string, unknown>[],
  ): void {
    const handle = sessions.get(tabId);
    if (!handle) return;
    if (!handle.inputChannel) return; // TUI mode — input goes through PTY

    if (handle.query) {
      ensureLiveQuery(tabId, handle);
    }

    // See sendMessage() — keep conversationStatus in sync with submit, not echo.
    setStatus(handle, { conversationStatus: 'running' }, tabId, sendToRenderer);

    const message: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: content as any,
      },
      parent_tool_use_id: null,
    };

    handle.inputChannel.push(message);
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
    if (handle.inputChannel) handle.inputChannel.close();
    if (handle.query) { try { handle.query.close(); } catch { /* ignore */ } }
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

      // Mark as tui BEFORE closing the SDK query so that the listenToMessages
      // cleanup guard sees mode === 'tui' and skips the session deletion.
      handle.mode = 'tui';

      // Close the SDK query cleanly.
      try { handle.query?.close?.(); } catch { /* best effort */ }
      if (handle.inputChannel) handle.inputChannel.close();

      const tui = createTuiSession({
        tabId,
        projectPath: handle.projectPath,
        configDir: handle.configDir,
        sessionId: handle.sessionId,
        resume: true, // mid-session toggle continues the existing session
        claudeBinaryPath: binaryPath,
      });

      tui.onData((data: string) => sendToRenderer(`session-tui-data:${tabId}`, data));
      tui.onExit((r: { exitCode: number }) => {
        sendToRenderer(`session-tui-exit:${tabId}`, r);
        handle.tuiJsonl?.stop();
        handle.tuiJsonl = null;
        // Auto-revert to SDK mode.
        void setMode(tabId, 'sdk').catch((e: unknown) =>
          console.error('[sessions] auto-revert to sdk failed:', e)
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
      // tui -> sdk: kill the pty, then re-start the SDK query with resume.
      handle.tuiJsonl?.stop();
      handle.tuiJsonl = null;
      handle.tuiDetach?.();
      handle.tui = null;
      handle.tuiDetach = null;
      handle.mode = 'sdk';
      sendToRenderer(`session-mode:${tabId}`, { mode: 'sdk' });

      // Re-start the SDK query on the same session id. Re-use the original
      // SDK options captured on the handle.
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
      if (existing.inputChannel) existing.inputChannel.close();
      if (existing.query) { try { existing.query.close(); } catch { /* ignore */ } }
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
      query: null,
      inputChannel: null,
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
      sdkOptions: {},
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
