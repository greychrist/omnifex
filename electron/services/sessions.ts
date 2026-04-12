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
  SDKUserMessage,
  Query,
  PermissionMode,
  AccountInfo,
  AgentInfo,
  ModelInfo,
  SlashCommand,
  SDKControlGetContextUsageResponse,
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

  // --- Wave 2: Query-method passthroughs ----------------------------------
  /** Interrupt the current assistant turn without ending the session. */
  interrupt(tabId: string): Promise<void>;
  /** Switch the model used for subsequent turns. */
  setModel(tabId: string, model?: string): Promise<void>;
  /** Switch the permission mode mid-session. */
  setPermissionMode(tabId: string, mode: PermissionMode): Promise<void>;
  /** Get the SDK-reported authenticated account for an active tab. Null if the tab isn't running. */
  getAccountInfo(tabId: string): Promise<AccountInfo | null>;
  /** Get the current context-window usage breakdown. Null if the tab isn't running. */
  getContextUsage(tabId: string): Promise<SDKControlGetContextUsageResponse | null>;
  /** Get the list of slash commands the SDK knows about for this session. Empty if no tab. */
  getSupportedCommands(tabId: string): Promise<SlashCommand[]>;
  /** Get the list of models the SDK knows about for this session. Empty if no tab. */
  getSupportedModels(tabId: string): Promise<ModelInfo[]>;
  /** Get the list of subagents the SDK knows about for this session. Empty if no tab. */
  getSupportedAgents(tabId: string): Promise<AgentInfo[]>;
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
      // Enable the 1M token context window for Sonnet 4/4.5. Opus 4.6
      // with [1m] already has 1M natively; this beta flag extends the
      // same to Sonnet models. Safe to pass unconditionally — models
      // that don't support it simply ignore the beta header.
      betas: ['context-1m-2025-08-07'],
    };

    // Route CLI subprocess stderr into the logging service. Note the CLI routes its
    // own `--debug` output to ~/.claude-personal/debug/<sessionId>.txt (not stderr),
    // so this callback only catches unexpected stderr (crashes, fatal errors).
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

      // Wave 3.3 — audit hooks.
      //
      // Register PreToolUse / PostToolUse / PostToolUseFailure callbacks that
      // write one log entry each to the logging service. Source 'claude-hooks'
      // so the Log tab can filter them distinctly from 'claude-sdk' (stderr)
      // and 'frontend' (renderer console). Each entry includes the tool name
      // in the message (with → / ← / ✗ direction indicators) and the full
      // tool_input / tool_response / error in the metadata JSON, capped to
      // ~4KB so a single huge Read response can't blow up a log row.
      //
      // The callbacks return `{}` (empty SyncHookJSONOutput) so the SDK
      // continues tool execution unimpeded — this is audit-only, not a
      // permission gate.

      const METADATA_CAP = 4000;
      const stringifyCapped = (obj: unknown): string => {
        try {
          const s = JSON.stringify(obj);
          if (s.length <= METADATA_CAP) return s;
          return s.slice(0, METADATA_CAP - 20) + '…[truncated]';
        } catch {
          return '"[unserializable]"';
        }
      };

      options.hooks = {
        PreToolUse: [
          {
            hooks: [
              async (input: any) => {
                try {
                  logging.writeBatch([
                    {
                      timestamp: new Date().toISOString(),
                      level: 'info',
                      source: 'claude-hooks',
                      category: `session:${tabId}`,
                      message: `→ ${input.tool_name}`,
                      metadata: stringifyCapped({
                        event: 'PreToolUse',
                        tool_name: input.tool_name,
                        tool_input: input.tool_input,
                        tool_use_id: input.tool_use_id,
                      }),
                    },
                  ]);
                } catch (err) {
                  console.error('[sessions] PreToolUse hook logging failed:', err);
                }
                return {};
              },
            ],
          },
        ],
        PostToolUse: [
          {
            hooks: [
              async (input: any) => {
                try {
                  logging.writeBatch([
                    {
                      timestamp: new Date().toISOString(),
                      level: 'info',
                      source: 'claude-hooks',
                      category: `session:${tabId}`,
                      message: `← ${input.tool_name}`,
                      metadata: stringifyCapped({
                        event: 'PostToolUse',
                        tool_name: input.tool_name,
                        tool_input: input.tool_input,
                        tool_response: input.tool_response,
                        tool_use_id: input.tool_use_id,
                      }),
                    },
                  ]);
                } catch (err) {
                  console.error('[sessions] PostToolUse hook logging failed:', err);
                }
                return {};
              },
            ],
          },
        ],
        PostToolUseFailure: [
          {
            hooks: [
              async (input: any) => {
                try {
                  const errMsg = typeof input.error === 'string' ? input.error : String(input.error ?? 'unknown error');
                  logging.writeBatch([
                    {
                      timestamp: new Date().toISOString(),
                      level: 'error',
                      source: 'claude-hooks',
                      category: `session:${tabId}`,
                      message: `✗ ${input.tool_name}: ${errMsg.slice(0, 200)}`,
                      metadata: stringifyCapped({
                        event: 'PostToolUseFailure',
                        tool_name: input.tool_name,
                        tool_input: input.tool_input,
                        error: errMsg,
                        tool_use_id: input.tool_use_id,
                      }),
                    },
                  ]);
                } catch (err) {
                  console.error('[sessions] PostToolUseFailure hook logging failed:', err);
                }
                return {};
              },
            ],
          },
        ],
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
  // Wave 2 — Query-method passthroughs
  //
  // Each method looks up the session handle for the tab and forwards to the
  // corresponding SDK Query method. Unknown tabs are no-ops (return null or []
  // depending on the expected shape). SDK errors are swallowed and reported
  // as null/[] so a misbehaving subprocess can't crash the IPC layer.
  // -------------------------------------------------------------------------

  async function interrupt(tabId: string): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) return;
    try {
      await handle.query.interrupt();
    } catch (err) {
      console.error(`[sessions] interrupt failed for tab ${tabId}:`, err);
    }
  }

  async function setModel(tabId: string, model?: string): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) return;
    try {
      await handle.query.setModel(model);
    } catch (err) {
      console.error(`[sessions] setModel failed for tab ${tabId}:`, err);
    }
  }

  async function setPermissionMode(tabId: string, mode: PermissionMode): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) return;
    try {
      await handle.query.setPermissionMode(mode);
    } catch (err) {
      console.error(`[sessions] setPermissionMode failed for tab ${tabId}:`, err);
    }
  }

  async function getAccountInfo(tabId: string): Promise<AccountInfo | null> {
    const handle = sessions.get(tabId);
    if (!handle) return null;
    try {
      return await handle.query.accountInfo();
    } catch (err) {
      console.error(`[sessions] accountInfo failed for tab ${tabId}:`, err);
      return null;
    }
  }

  async function getContextUsage(
    tabId: string,
  ): Promise<SDKControlGetContextUsageResponse | null> {
    const handle = sessions.get(tabId);
    if (!handle) return null;
    try {
      return await handle.query.getContextUsage();
    } catch (err) {
      console.error(`[sessions] getContextUsage failed for tab ${tabId}:`, err);
      return null;
    }
  }

  async function getSupportedCommands(tabId: string): Promise<SlashCommand[]> {
    const handle = sessions.get(tabId);
    if (!handle) return [];
    try {
      return await handle.query.supportedCommands();
    } catch (err) {
      console.error(`[sessions] supportedCommands failed for tab ${tabId}:`, err);
      return [];
    }
  }

  async function getSupportedModels(tabId: string): Promise<ModelInfo[]> {
    const handle = sessions.get(tabId);
    if (!handle) return [];
    try {
      return await handle.query.supportedModels();
    } catch (err) {
      console.error(`[sessions] supportedModels failed for tab ${tabId}:`, err);
      return [];
    }
  }

  async function getSupportedAgents(tabId: string): Promise<AgentInfo[]> {
    const handle = sessions.get(tabId);
    if (!handle) return [];
    try {
      return await handle.query.supportedAgents();
    } catch (err) {
      console.error(`[sessions] supportedAgents failed for tab ${tabId}:`, err);
      return [];
    }
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
    interrupt,
    setModel,
    setPermissionMode,
    getAccountInfo,
    getContextUsage,
    getSupportedCommands,
    getSupportedModels,
    getSupportedAgents,
  };
}
