// Sessions module — controller (factory + session management)
//
// Thin glue layer that composes `factory.buildSdkOptions` (SDK options
// assembly), `runtime.listenToMessages` / `runtime.restartQuery` (the
// stream FSM), and the per-tab `permissions.canUseTool` callback.
// Holds the live `Map<tabId, SessionHandle>` and exposes the public
// `SessionsService` IPC surface.

import { createAsyncChannel } from '../async-channel';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  SessionHandle,
  SessionStartParams,
  SessionStatus,
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
  onSessionClosed: ((sessionId: string, projectPath: string) => void) | null = null,
): SessionsService {
  const sessions = new Map<string, SessionHandle>();

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

  function start(params: SessionStartParams): void {
    const { tabId, projectPath, configDir } = params;

    // Close any existing session for this tab
    const existing = sessions.get(tabId);
    if (existing) {
      existing.inputChannel.close();
      existing.query.close();
      sessions.delete(tabId);
      ownership?.unregister(tabId);
    }

    const inputChannel = createAsyncChannel<SDKUserMessage>(1000);

    // Build the SDK options. The factory excludes `canUseTool` because
    // that callback closes over the handle (which is created below).
    // Elicitation requests are routed to a resolver that the runtime
    // writes to handle.elicitationResolver in respondElicitation().
    const options = buildSdkOptions(params, {
      tabId,
      sendToRenderer,
      notificationHooks,
      logging,
      onElicitationRequest: (_request) =>
        new Promise<ElicitationDecision>((resolve) => {
          handle.elicitationResolver = (decision) => {
            handle.elicitationResolver = null;
            resolve(decision);
          };
        }),
    });

    // Create handle first so the canUseTool callback can reference it
    const handle: SessionHandle = {
      query: null as any, // set below
      inputChannel,
      sessionId: null,
      status: 'starting',
      mode: 'sdk',
      tui: null,
      tuiDetach: null,
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

    // Start the SDK query with the async input channel
    const q = query({
      prompt: inputChannel,
      options: options as any,
    });

    handle.query = q;
    sessions.set(tabId, handle);
    if (params.ownerWebContentsId !== undefined) {
      ownership?.register(tabId, params.ownerWebContentsId);
    }

    // Start listening in the background (don't await — fire and forget)
    listenToMessages(tabId, handle, runtimeDeps).catch((err) => {
      console.error(`[sessions] Unhandled error in listenToMessages for tab ${tabId}:`, err);
    });
  }

  // -------------------------------------------------------------------------
  // sendMessage() / sendStructuredMessage()
  // -------------------------------------------------------------------------

  function ensureLiveQuery(tabId: string, handle: SessionHandle): void {
    // If the previous stream errored, restart the SDK query transparently
    if (handle.status === 'error') {
      restartQuery(tabId, handle, runtimeDeps);
    }
  }

  function sendMessage(tabId: string, prompt: string): void {
    const handle = sessions.get(tabId);
    if (!handle) return;

    ensureLiveQuery(tabId, handle);

    // Mark the turn as in-flight before the SDK has a chance to echo
    // anything back, so the installer's wait-for-idle gate reacts to the
    // user's submit immediately.
    handle.status = 'running';

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
    content: Array<Record<string, unknown>>,
  ): void {
    const handle = sessions.get(tabId);
    if (!handle) return;

    ensureLiveQuery(tabId, handle);

    // See sendMessage() — keep status in sync with submit, not echo.
    handle.status = 'running';

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

    handle.tuiDetach?.();
    handle.inputChannel.close();
    handle.query.close();
    sessions.delete(tabId);
    ownership?.unregister(tabId);

    if (closedSessionId && closedProjectPath && onSessionClosed) {
      // Fire-and-forget — auto-on-close summarization shouldn't block
      // session teardown, and any errors are logged inside the hook.
      try {
        onSessionClosed(closedSessionId, closedProjectPath);
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

  function getStatus(tabId: string): SessionStatus {
    return sessions.get(tabId)?.status ?? 'stopped';
  }

  function getInfo(tabId: string): { sessionId: string | null; status: SessionStatus } | null {
    const handle = sessions.get(tabId);
    if (!handle) return null;
    return { sessionId: handle.sessionId, status: handle.status };
  }

  function isActive(tabId: string): boolean {
    return sessions.has(tabId);
  }

  function listActiveTabIds(): string[] {
    return Array.from(sessions.keys());
  }

  function listInFlightTabIds(): string[] {
    const ids: string[] = [];
    for (const [tabId, handle] of sessions) {
      if (
        handle.status === 'starting' ||
        handle.status === 'running' ||
        handle.status === 'waiting_permission'
      ) {
        ids.push(tabId);
      }
    }
    return ids;
  }

  function listSessionStatuses(): Array<{ tabId: string; status: SessionStatus }> {
    const out: Array<{ tabId: string; status: SessionStatus }> = [];
    for (const [tabId, handle] of sessions) {
      out.push({ tabId, status: handle.status });
    }
    return out;
  }

  function getHealth(tabId: string): { alive: boolean; status: SessionStatus; sessionId: string | null } {
    const handle = sessions.get(tabId);
    if (!handle) return { alive: false, status: 'stopped', sessionId: null };
    return { alive: true, status: handle.status, sessionId: handle.sessionId };
  }

  async function setMode(tabId: string, mode: SessionMode): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) throw new Error(`setMode: unknown tab ${tabId}`);
    if (handle.mode === mode) return;

    // Gate: allow switching while the SDK is running, idle (between turns),
    // or in the transient 'starting' state (post-restart, before the first
    // message arrives). Block only when a permission dialog is open or the
    // session is dead.
    if (
      handle.status !== 'running' &&
      handle.status !== 'idle' &&
      handle.status !== 'starting'
    ) {
      throw new Error(`setMode: not allowed while status is "${handle.status}"`);
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
      handle.inputChannel.close();

      const tui = createTuiSession({
        tabId,
        projectPath: handle.projectPath,
        configDir: handle.configDir,
        sessionId: handle.sessionId,
        claudeBinaryPath: binaryPath,
      });

      tui.onData((data: string) => sendToRenderer(`session-tui-data:${tabId}`, data));
      tui.onExit((r: { exitCode: number }) => {
        sendToRenderer(`session-tui-exit:${tabId}`, r);
        // Auto-revert to SDK mode.
        void setMode(tabId, 'sdk').catch((e) =>
          console.error('[sessions] auto-revert to sdk failed:', e)
        );
      });

      handle.tui = tui;
      handle.tuiDetach = () => { try { tui.kill(); } catch { /* best effort */ } };
      sendToRenderer(`session-mode:${tabId}`, { mode: 'tui' });
    } else {
      // tui -> sdk: kill the pty, then re-start the SDK query with resume.
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
    ...createQueryPassthroughs(sessions),
  };
}
