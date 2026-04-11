// Sessions service — wraps the Claude Agent SDK's query() for multi-turn
// interactive sessions. Runs in Electron's main process where Node.js APIs
// and the SDK subprocess launch are available.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAsyncChannel, type AsyncChannel } from './async-channel';
import type { LoggingService } from './logging';

// ---------------------------------------------------------------------------
// SDK imports
// ---------------------------------------------------------------------------

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
  resumeSessionId?: string;
}

export interface SessionsService {
  start(params: SessionStartParams): void;
  sendMessage(tabId: string, prompt: string): void;
  sendStructuredMessage(tabId: string, content: Array<Record<string, unknown>>): void;
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

interface NotificationHooks {
  /** Show a native OS notification */
  showNotification?: (title: string, body: string, isError: boolean) => void;
  /** Increment unread count / update dock badge */
  incrementUnread?: () => void;
}

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
  projectPath: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Find the system-installed claude binary (needed because the SDK's bundled binary may be missing). */
function findSystemClaudeBinary(): string | null {
  const candidates = [
    `${os.homedir()}/.local/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function createSessionsService(
  sendToRenderer: SendToRenderer,
  notificationHooks: NotificationHooks = {},
  logging: LoggingService | null = null,
): SessionsService {
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
        sendToRenderer(`claude-output:${tabId}`, message);

        // Emit notification event on result messages (execution complete/failed)
        if (message.type === 'result') {
          const msg = message as any;
          const isError = msg.is_error || msg.subtype === 'error';
          const projectName = path.basename(handle.projectPath) || 'GreyChrist';
          const title = `GreyChrist — ${projectName}`;
          const body = (msg.result || msg.error || (isError ? 'Task failed' : 'Task complete')).slice(0, 200);

          // Emit to renderer for in-app tab badge handling
          sendToRenderer('claude-notification', {
            tab_id: tabId,
            title,
            body,
            is_error: isError,
          });

          // Fire native OS notification + dock badge
          try {
            notificationHooks.showNotification?.(title, body, isError);
            notificationHooks.incrementUnread?.();
          } catch (e) {
            console.error('[sessions] notification hook failed:', e);
          }
        }
      }
    } catch (err) {
      handle.status = 'error';
      sendToRenderer(`claude-error:${tabId}`, err instanceof Error ? err.message : String(err));
    } finally {
      handle.status = 'stopped';
      sendToRenderer(`claude-complete:${tabId}`);
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
      // Load project CLAUDE.md, .claude/skills/*, .claude/commands/*, .claude/settings.json,
      // and user ~/.claude/settings.json. Without this the SDK runs in isolation mode and
      // ignores all filesystem-based project config — defeating the point of a Claude Code GUI.
      settingSources: ['user', 'project', 'local'],
      // Surface invalid MCP configs as errors instead of silent warnings.
      strictMcpConfig: true,
    };

    // Route CLI subprocess stderr into the logging service so it shows up in the Log tab.
    if (logging) {
      options.stderr = (data: string) => {
        logging.writeBatch([
          {
            timestamp: new Date().toISOString(),
            level: 'debug',
            source: 'claude-sdk',
            category: `session:${tabId}`,
            message: data,
          },
        ]);
      };
    }

    // Use system-installed claude binary (account is scoped via CLAUDE_CONFIG_DIR)
    const binaryPath = findSystemClaudeBinary();
    if (binaryPath) {
      options.pathToClaudeCodeExecutable = binaryPath;
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
      projectPath,
    };

    // Permission callback: called by the SDK before each tool execution
    options.canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      opts: { signal: AbortSignal; title?: string; description?: string; displayName?: string },
    ) => {
      // Auto-allow if enabled and tool is in the allow-list
      if (handle.autoAllowEnabled && handle.autoAllowedTools.has(toolName)) {
        return { behavior: 'allow' as const, updatedInput: input };
      }

      // Ask the renderer for a permission decision by sending a permission_request
      // message through the normal stream channel (same as all other messages)
      handle.status = 'waiting_permission';
      const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      sendToRenderer(`claude-output:${tabId}`, {
        type: 'permission_request',
        request_id: requestId,
        tool_name: toolName,
        tool_input: input,
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
          // Fall back to the original input if the UI didn't modify it
          updatedInput: decision.updatedInput ?? input,
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

  function sendStructuredMessage(
    tabId: string,
    content: Array<Record<string, unknown>>,
  ): void {
    const handle = sessions.get(tabId);
    if (!handle) return;

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
    sendStructuredMessage,
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
