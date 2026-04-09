// Sessions service — wraps the Claude Agent SDK's query() for multi-turn
// interactive sessions. Runs in Electron's main process where Node.js APIs
// and the SDK subprocess launch are available.

import { createAsyncChannel, type AsyncChannel } from './async-channel';

// ---------------------------------------------------------------------------
// SDK imports — use `any` for types that may not export cleanly at runtime
// ---------------------------------------------------------------------------

// The SDK types reference zod/v4 which conflicts with the project's zod v3.
// We import only what we need and fall back to `any` where necessary.
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKMessage,
  SDKUserMessage,
  Query,
  PermissionMode,
} from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SessionStatus = 'starting' | 'running' | 'waiting_permission' | 'stopped' | 'error';

export interface SessionStartParams {
  tabId: string;
  projectPath: string;
  configDir: string;
  model: string;
  permissionMode: string;
  claudeBinaryPath?: string;
  resumeSessionId?: string;
}

export interface SessionsService {
  start(params: SessionStartParams): void;
  sendMessage(tabId: string, prompt: string): void;
  respondPermission(
    tabId: string,
    behavior: 'allow' | 'deny',
    updatedInput?: Record<string, unknown>,
  ): void;
  setAutoAllow(tabId: string, enabled: boolean): void;
  addAutoAllowTool(tabId: string, toolName: string): void;
  stop(tabId: string): void;
  stopAll(): void;
  getSessionId(tabId: string): string | null;
  getStatus(tabId: string): SessionStatus;
  getInfo(tabId: string): { sessionId: string | null; status: SessionStatus } | null;
  isActive(tabId: string): boolean;
}

type SendToRenderer = (channel: string, ...args: unknown[]) => void;

// ---------------------------------------------------------------------------
// Internal session handle
// ---------------------------------------------------------------------------

interface PermissionDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
}

interface SessionHandle {
  query: Query;
  inputChannel: AsyncChannel<SDKUserMessage>;
  sessionId: string | null;
  status: SessionStatus;
  permissionResolver: ((decision: PermissionDecision) => void) | null;
  autoAllowEnabled: boolean;
  autoAllowedTools: Set<string>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionsService(sendToRenderer: SendToRenderer): SessionsService {
  const sessions = new Map<string, SessionHandle>();

  // -------------------------------------------------------------------------
  // Internal: start the async listener loop for a session
  // -------------------------------------------------------------------------

  async function listenToMessages(tabId: string, handle: SessionHandle): Promise<void> {
    try {
      for await (const message of handle.query) {
        // Extract session ID from system init message
        if (
          message.type === 'system' &&
          (message as any).subtype === 'init' &&
          (message as any).session_id
        ) {
          handle.sessionId = (message as any).session_id as string;
        }

        handle.status = 'running';

        // Forward every message to the renderer
        sendToRenderer(`session-message:${tabId}`, message);
      }
    } catch (err) {
      handle.status = 'error';
      sendToRenderer(`session-error:${tabId}`, err instanceof Error ? err.message : String(err));
    } finally {
      handle.status = 'stopped';
      sendToRenderer(`session-status:${tabId}`, 'stopped');
      sessions.delete(tabId);
    }
  }

  // -------------------------------------------------------------------------
  // start()
  // -------------------------------------------------------------------------

  function start(params: SessionStartParams): void {
    const {
      tabId,
      projectPath,
      configDir,
      model,
      permissionMode,
      claudeBinaryPath,
      resumeSessionId,
    } = params;

    // Close any existing session for this tab
    const existing = sessions.get(tabId);
    if (existing) {
      existing.inputChannel.close();
      existing.query.close();
      sessions.delete(tabId);
    }

    const inputChannel = createAsyncChannel<SDKUserMessage>();

    // Build the SDK options
    const options: Record<string, unknown> = {
      cwd: projectPath,
      model,
      permissionMode: permissionMode as PermissionMode,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
      },
    };

    if (claudeBinaryPath) {
      options.pathToClaudeCodeExecutable = claudeBinaryPath;
    }

    if (resumeSessionId) {
      options.resume = resumeSessionId;
    }

    // Create handle first so the canUseTool callback can reference it
    const handle: SessionHandle = {
      query: null as any, // set below
      inputChannel,
      sessionId: null,
      status: 'starting',
      permissionResolver: null,
      autoAllowEnabled: false,
      autoAllowedTools: new Set(),
    };

    // Permission callback: called by the SDK before each tool execution
    options.canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      opts: { signal: AbortSignal; title?: string; description?: string; displayName?: string },
    ) => {
      // Auto-allow if enabled and tool is in the allow-list
      if (handle.autoAllowEnabled && handle.autoAllowedTools.has(toolName)) {
        return { behavior: 'allow' as const };
      }

      // Ask the renderer for a permission decision
      handle.status = 'waiting_permission';
      sendToRenderer(`session-permission:${tabId}`, {
        toolName,
        input,
        title: opts.title,
        description: opts.description,
        displayName: opts.displayName,
      });

      const decision = await new Promise<PermissionDecision>((resolve) => {
        handle.permissionResolver = resolve;
      });

      handle.status = 'running';
      handle.permissionResolver = null;

      if (decision.behavior === 'allow') {
        return {
          behavior: 'allow' as const,
          updatedInput: decision.updatedInput,
        };
      }

      return {
        behavior: 'deny' as const,
        message: 'User denied permission',
      };
    };

    // Start the SDK query with the async input channel
    const q = query({
      prompt: inputChannel,
      options: options as any,
    });

    handle.query = q;
    sessions.set(tabId, handle);

    // Start listening in the background (don't await — fire and forget)
    listenToMessages(tabId, handle).catch((err) => {
      console.error(`[sessions] Unhandled error in listenToMessages for tab ${tabId}:`, err);
    });
  }

  // -------------------------------------------------------------------------
  // sendMessage()
  // -------------------------------------------------------------------------

  function sendMessage(tabId: string, prompt: string): void {
    const handle = sessions.get(tabId);
    if (!handle) return;

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

  // -------------------------------------------------------------------------
  // respondPermission()
  // -------------------------------------------------------------------------

  function respondPermission(
    tabId: string,
    behavior: 'allow' | 'deny',
    updatedInput?: Record<string, unknown>,
  ): void {
    const handle = sessions.get(tabId);
    if (!handle || !handle.permissionResolver) return;

    handle.permissionResolver({ behavior, updatedInput });
  }

  // -------------------------------------------------------------------------
  // setAutoAllow() / addAutoAllowTool()
  // -------------------------------------------------------------------------

  function setAutoAllow(tabId: string, enabled: boolean): void {
    const handle = sessions.get(tabId);
    if (!handle) return;
    handle.autoAllowEnabled = enabled;
  }

  function addAutoAllowTool(tabId: string, toolName: string): void {
    const handle = sessions.get(tabId);
    if (!handle) return;
    handle.autoAllowedTools.add(toolName);
  }

  // -------------------------------------------------------------------------
  // stop() / stopAll()
  // -------------------------------------------------------------------------

  function stop(tabId: string): void {
    const handle = sessions.get(tabId);
    if (!handle) return;

    handle.inputChannel.close();
    handle.query.close();
    sessions.delete(tabId);
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

  // -------------------------------------------------------------------------
  // Return service
  // -------------------------------------------------------------------------

  return {
    start,
    sendMessage,
    respondPermission,
    setAutoAllow,
    addAutoAllowTool,
    stop,
    stopAll,
    getSessionId,
    getStatus,
    getInfo,
    isActive,
  };
}
