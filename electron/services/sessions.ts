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
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';

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
  effort?: 'low' | 'medium' | 'high' | 'max';
  thinking?: { type: 'adaptive'; display?: 'summarized' | 'omitted' }
    | { type: 'enabled'; budgetTokens?: number; display?: 'summarized' | 'omitted' }
    | { type: 'disabled' };
}

export interface SessionsService {
  start(params: SessionStartParams): void;
  sendMessage(tabId: string, prompt: string): void;
  sendStructuredMessage(tabId: string, content: Array<Record<string, unknown>>): void;
  respondPermission(
    tabId: string,
    behavior: 'allow' | 'deny',
    updatedInput?: Record<string, unknown>,
    updatedPermissions?: PermissionDecision['updatedPermissions'],
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
  /** Change effort level mid-session. null = auto (clear setting). */
  setEffort(tabId: string, level: 'low' | 'medium' | 'high' | 'max' | null): Promise<void>;
  /** Change thinking mode mid-session. */
  setThinking(tabId: string, config: SessionStartParams['thinking']): Promise<void>;
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
  /** Get live MCP server status for an active session. Empty if no tab. */
  getMcpServerStatus(tabId: string): Promise<McpServerStatus[]>;
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
  /** Permission rule updates to persist (for "Allow & Remember"). */
  updatedPermissions?: Array<{
    type: 'addRules';
    rules: Array<{ toolName: string; ruleContent?: string }>;
    behavior: 'allow';
    destination: 'session' | 'projectSettings' | 'userSettings';
  }>;
}

interface PendingPermission {
  requestId: string;
  resolve: (decision: PermissionDecision) => void;
}

interface SessionHandle {
  query: Query;
  inputChannel: AsyncChannel<SDKUserMessage>;
  sessionId: string | null;
  status: SessionStatus;
  permissionResolver: ((decision: PermissionDecision) => void) | null;
  /** Queue of permission requests waiting for user response */
  permissionQueue: PendingPermission[];
  autoAllowEnabled: boolean;
  autoAllowedTools: Set<string>;
  projectPath: string;
  configDir: string;
  /** Saved SDK options so we can restart the query after a stream error. */
  sdkOptions: Record<string, unknown>;
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
      // Stream error — keep the session alive so the user can retry.
      // The next sendMessage() will restart the SDK query transparently.
      handle.status = 'error';
      const errMsg = err instanceof Error ? err.message : String(err);
      sendToRenderer(`claude-error:${tabId}`, errMsg);
      sendToRenderer(`claude-output:${tabId}`, {
        type: 'system',
        subtype: 'notification',
        notification_type: 'error',
        title: 'Session Error',
        message: `Error: ${errMsg.slice(0, 200)}`,
      });
      // Stop the loading indicator but keep the session in the map
      sendToRenderer(`claude-complete:${tabId}`);
      return;
    }
    // Normal stream close — clean up
    handle.status = 'stopped';
    sendToRenderer(`claude-complete:${tabId}`);
    sessions.delete(tabId);
  }

  // -------------------------------------------------------------------------
  // Internal: restart a dead query (after stream error) so the session resumes
  // -------------------------------------------------------------------------

  function restartQuery(tabId: string, handle: SessionHandle): void {
    const newInputChannel = createAsyncChannel<SDKUserMessage>();
    const opts = { ...handle.sdkOptions };
    if (handle.sessionId) {
      opts.resume = handle.sessionId;
    }

    const q = query({
      prompt: newInputChannel,
      options: opts as any,
    });

    handle.inputChannel = newInputChannel;
    handle.query = q;
    handle.status = 'starting';

    listenToMessages(tabId, handle).catch((err) => {
      console.error(`[sessions] Unhandled error in listenToMessages for tab ${tabId}:`, err);
    });
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
      effort,
      thinking,
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
      // Auto-approve all project .mcp.json servers so they connect without
      // interactive approval (which the SDK would otherwise silently decline).
      settings: {
        enableAllProjectMcpServers: true,
      },
      // Elicitation is handled by the Elicitation hook (when logging is enabled)
      // or this fallback (when logging is disabled). Both auto-accept.
      onElicitation: async () => ({ action: 'accept' as const }),
    };

    if (effort) {
      options.effort = effort;
    }
    if (thinking) {
      options.thinking = thinking;
    }

    // Route CLI subprocess stderr into the logging service. Note the CLI routes its
    // own `--debug` output to ~/.claude-personal/debug/<sessionId>.txt (not stderr),
    // so this callback only catches unexpected stderr (crashes, fatal errors).
    if (logging) {
      options.stderr = (data: string) => {
        // Detect error-like patterns in stderr and log at appropriate level
        const isError = /^error[:\s]|Error in hook callback|stream closed|FATAL|panic/i.test(data);
        logging.writeBatch([
          {
            timestamp: new Date().toISOString(),
            level: isError ? 'error' : 'debug',
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

        // ---- Bonus hooks: SubagentStart, SubagentStop, PreCompact, FileChanged ----

        SubagentStart: [
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
                      message: `🔀 subagent started: ${input.agent_type} (${input.agent_id})`,
                      metadata: stringifyCapped({
                        event: 'SubagentStart',
                        agent_id: input.agent_id,
                        agent_type: input.agent_type,
                      }),
                    },
                  ]);
                  sendToRenderer(`claude-subagent:${tabId}`, {
                    status: 'started',
                    agent_id: input.agent_id,
                    agent_type: input.agent_type,
                  });
                } catch (err) {
                  console.error('[sessions] SubagentStart hook failed:', err);
                }
                return {};
              },
            ],
          },
        ],
        SubagentStop: [
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
                      message: `🔀 subagent stopped: ${input.agent_type} (${input.agent_id})`,
                      metadata: stringifyCapped({
                        event: 'SubagentStop',
                        agent_id: input.agent_id,
                        agent_type: input.agent_type,
                        last_assistant_message: input.last_assistant_message,
                      }),
                    },
                  ]);
                  sendToRenderer(`claude-subagent:${tabId}`, {
                    status: 'stopped',
                    agent_id: input.agent_id,
                    agent_type: input.agent_type,
                    last_assistant_message: input.last_assistant_message,
                  });
                } catch (err) {
                  console.error('[sessions] SubagentStop hook failed:', err);
                }
                return {};
              },
            ],
          },
        ],
        PreCompact: [
          {
            hooks: [
              async (input: any) => {
                try {
                  logging.writeBatch([
                    {
                      timestamp: new Date().toISOString(),
                      level: 'warn',
                      source: 'claude-hooks',
                      category: `session:${tabId}`,
                      message: `⚠ context compacting (trigger: ${input.trigger})`,
                      metadata: stringifyCapped({
                        event: 'PreCompact',
                        trigger: input.trigger,
                      }),
                    },
                  ]);
                  sendToRenderer(`claude-compact:${tabId}`, {
                    trigger: input.trigger,
                  });
                } catch (err) {
                  console.error('[sessions] PreCompact hook failed:', err);
                }
                return {};
              },
            ],
          },
        ],
        Notification: [
          {
            hooks: [
              async (input: any) => {
                try {
                  const isError = /error/i.test(input.notification_type ?? '');
                  const level = isError ? 'error' : /warn/i.test(input.notification_type ?? '') ? 'warn' : 'info';
                  logging.writeBatch([
                    {
                      timestamp: new Date().toISOString(),
                      level,
                      source: 'claude-hooks',
                      category: `session:${tabId}`,
                      message: `💬 ${input.message ?? '(no message)'}`,
                      metadata: stringifyCapped({
                        event: 'Notification',
                        notification_type: input.notification_type,
                        title: input.title,
                        message: input.message,
                      }),
                    },
                  ]);
                  // Emit on the existing claude-notification channel so
                  // useNotifications.ts picks it up for tab badges + bring-
                  // to-front. The payload shape matches what the listener
                  // already expects (tab_id, title, body, is_error).
                  sendToRenderer('claude-notification', {
                    tab_id: tabId,
                    title: input.title ?? 'Claude',
                    body: input.message ?? '',
                    is_error: isError,
                  });
                  // Emit on the chat stream so the notification appears
                  // inline in the session message list.
                  sendToRenderer(`claude-output:${tabId}`, {
                    type: 'system',
                    subtype: 'notification',
                    message: input.message ?? '',
                    title: input.title,
                    notification_type: input.notification_type ?? 'info',
                  });
                } catch (err) {
                  console.error('[sessions] Notification hook failed:', err);
                }
                return {};
              },
            ],
          },
        ],
        FileChanged: [
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
                      message: `📄 file ${input.event}: ${input.file_path}`,
                      metadata: stringifyCapped({
                        event: 'FileChanged',
                        file_path: input.file_path,
                        change_event: input.event,
                      }),
                    },
                  ]);
                } catch (err) {
                  console.error('[sessions] FileChanged hook failed:', err);
                }
                return {};
              },
            ],
          },
        ],

        // ---- Session lifecycle hooks ----

        SessionStart: [
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
                      message: `▶ session ${input.source}${input.model ? ` (${input.model})` : ''}`,
                      metadata: stringifyCapped({
                        event: 'SessionStart',
                        source: input.source,
                        model: input.model,
                        agent_type: input.agent_type,
                      }),
                    },
                  ]);
                  sendToRenderer(`claude-output:${tabId}`, {
                    type: 'system',
                    subtype: 'session_lifecycle',
                    event: 'start',
                    source: input.source,
                    model: input.model,
                  });
                } catch (err) {
                  console.error('[sessions] SessionStart hook failed:', err);
                }
                return {};
              },
            ],
          },
        ],
        SessionEnd: [
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
                      message: `■ session ended: ${input.reason}`,
                      metadata: stringifyCapped({
                        event: 'SessionEnd',
                        reason: input.reason,
                      }),
                    },
                  ]);
                  sendToRenderer(`claude-output:${tabId}`, {
                    type: 'system',
                    subtype: 'session_lifecycle',
                    event: 'end',
                    reason: input.reason,
                  });
                } catch (err) {
                  console.error('[sessions] SessionEnd hook failed:', err);
                }
                return {};
              },
            ],
          },
        ],

        // ---- Turn boundary hooks ----

        Stop: [
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
                      message: `⏹ turn complete`,
                      metadata: stringifyCapped({
                        event: 'Stop',
                        stop_hook_active: input.stop_hook_active,
                        last_assistant_message: input.last_assistant_message,
                      }),
                    },
                  ]);
                } catch (err) {
                  console.error('[sessions] Stop hook failed:', err);
                }
                return {};
              },
            ],
          },
        ],
        StopFailure: [
          {
            hooks: [
              async (input: any) => {
                try {
                  const errMsg =
                    typeof input.error === 'string'
                      ? input.error
                      : input.error?.message ?? String(input.error ?? 'unknown error');
                  logging.writeBatch([
                    {
                      timestamp: new Date().toISOString(),
                      level: 'error',
                      source: 'claude-hooks',
                      category: `session:${tabId}`,
                      message: `✗ turn failed: ${errMsg.slice(0, 200)}`,
                      metadata: stringifyCapped({
                        event: 'StopFailure',
                        error: input.error,
                        error_details: input.error_details,
                      }),
                    },
                  ]);
                  sendToRenderer(`claude-output:${tabId}`, {
                    type: 'system',
                    subtype: 'stop_failure',
                    error: errMsg,
                    error_details: input.error_details,
                  });
                } catch (err) {
                  console.error('[sessions] StopFailure hook failed:', err);
                }
                return {};
              },
            ],
          },
        ],

        // ---- PostCompact ----

        PostCompact: [
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
                      message: `✂ context compacted (${input.trigger})`,
                      metadata: stringifyCapped({
                        event: 'PostCompact',
                        trigger: input.trigger,
                        compact_summary: input.compact_summary,
                      }),
                    },
                  ]);
                  sendToRenderer(`claude-output:${tabId}`, {
                    type: 'system',
                    subtype: 'post_compact',
                    trigger: input.trigger,
                    compact_summary: input.compact_summary,
                  });
                } catch (err) {
                  console.error('[sessions] PostCompact hook failed:', err);
                }
                return {};
              },
            ],
          },
        ],

        // ---- Permission audit ----

        PermissionDenied: [
          {
            hooks: [
              async (input: any) => {
                try {
                  logging.writeBatch([
                    {
                      timestamp: new Date().toISOString(),
                      level: 'warn',
                      source: 'claude-hooks',
                      category: `session:${tabId}`,
                      message: `🚫 ${input.tool_name} denied: ${(input.reason ?? 'no reason').slice(0, 200)}`,
                      metadata: stringifyCapped({
                        event: 'PermissionDenied',
                        tool_name: input.tool_name,
                        tool_input: input.tool_input,
                        tool_use_id: input.tool_use_id,
                        reason: input.reason,
                      }),
                    },
                  ]);
                  sendToRenderer(`claude-output:${tabId}`, {
                    type: 'system',
                    subtype: 'permission_denied',
                    tool_name: input.tool_name,
                    reason: input.reason,
                  });
                } catch (err) {
                  console.error('[sessions] PermissionDenied hook failed:', err);
                }
                return {};
              },
            ],
          },
        ],

        // ---- #16 UserPromptSubmit ----
        UserPromptSubmit: [
          {
            hooks: [
              async (input: any) => {
                try {
                  logging.writeBatch([{
                    timestamp: new Date().toISOString(),
                    level: 'info',
                    source: 'claude-hooks',
                    category: `session:${tabId}`,
                    message: `📝 prompt submitted (${(input.prompt ?? '').length} chars)`,
                    metadata: stringifyCapped({ event: 'UserPromptSubmit', prompt: input.prompt, session_title: input.session_title }),
                  }]);
                  sendToRenderer(`claude-output:${tabId}`, {
                    type: 'system', subtype: 'user_prompt_submit',
                    prompt_length: (input.prompt ?? '').length,
                    session_title: input.session_title,
                  });
                } catch (err) { console.error('[sessions] UserPromptSubmit hook failed:', err); }
                return {};
              },
            ],
          },
        ],

        // ---- #17 Setup ----
        Setup: [
          {
            hooks: [
              async (input: any) => {
                try {
                  logging.writeBatch([{
                    timestamp: new Date().toISOString(),
                    level: 'info',
                    source: 'claude-hooks',
                    category: `session:${tabId}`,
                    message: `⚙ setup: ${input.trigger}`,
                    metadata: stringifyCapped({ event: 'Setup', trigger: input.trigger }),
                  }]);
                  sendToRenderer(`claude-output:${tabId}`, {
                    type: 'system', subtype: 'notification', notification_type: 'info',
                    title: 'Setup',
                    message: `Session ${input.trigger === 'init' ? 'initializing' : 'maintenance running'}`,
                  });
                } catch (err) { console.error('[sessions] Setup hook failed:', err); }
                return {};
              },
            ],
          },
        ],

        // ---- #19 TaskCreated ----
        TaskCreated: [
          {
            hooks: [
              async (input: any) => {
                try {
                  logging.writeBatch([{
                    timestamp: new Date().toISOString(),
                    level: 'info',
                    source: 'claude-hooks',
                    category: `session:${tabId}`,
                    message: `📋 task created: ${input.task_subject}${input.teammate_name ? ` (${input.teammate_name})` : ''}`,
                    metadata: stringifyCapped({ event: 'TaskCreated', task_id: input.task_id, task_subject: input.task_subject, task_description: input.task_description, teammate_name: input.teammate_name, team_name: input.team_name }),
                  }]);
                  sendToRenderer(`claude-output:${tabId}`, {
                    type: 'system', subtype: 'task_event', event: 'created',
                    task_id: input.task_id, task_subject: input.task_subject,
                    task_description: input.task_description,
                    teammate_name: input.teammate_name, team_name: input.team_name,
                  });
                } catch (err) { console.error('[sessions] TaskCreated hook failed:', err); }
                return {};
              },
            ],
          },
        ],

        // ---- #20 TaskCompleted ----
        TaskCompleted: [
          {
            hooks: [
              async (input: any) => {
                try {
                  logging.writeBatch([{
                    timestamp: new Date().toISOString(),
                    level: 'info',
                    source: 'claude-hooks',
                    category: `session:${tabId}`,
                    message: `✅ task completed: ${input.task_subject}${input.teammate_name ? ` (${input.teammate_name})` : ''}`,
                    metadata: stringifyCapped({ event: 'TaskCompleted', task_id: input.task_id, task_subject: input.task_subject, task_description: input.task_description, teammate_name: input.teammate_name, team_name: input.team_name }),
                  }]);
                  sendToRenderer(`claude-output:${tabId}`, {
                    type: 'system', subtype: 'task_event', event: 'completed',
                    task_id: input.task_id, task_subject: input.task_subject,
                    task_description: input.task_description,
                    teammate_name: input.teammate_name, team_name: input.team_name,
                  });
                  try {
                    notificationHooks.showNotification?.(`Task Complete: ${input.task_subject}`, input.teammate_name ? `Completed by ${input.teammate_name}` : 'Task finished', false);
                    notificationHooks.incrementUnread?.();
                  } catch { /* notification optional */ }
                } catch (err) { console.error('[sessions] TaskCompleted hook failed:', err); }
                return {};
              },
            ],
          },
        ],

        // ---- #21 Elicitation ----
        Elicitation: [
          {
            hooks: [
              async (input: any) => {
                try {
                  logging.writeBatch([{
                    timestamp: new Date().toISOString(),
                    level: 'info',
                    source: 'claude-hooks',
                    category: `session:${tabId}`,
                    message: `🔑 elicitation from ${input.mcp_server_name}: ${(input.message ?? '').slice(0, 100)}`,
                    metadata: stringifyCapped({ event: 'Elicitation', mcp_server_name: input.mcp_server_name, message: input.message, mode: input.mode, url: input.url, elicitation_id: input.elicitation_id, requested_schema: input.requested_schema }),
                  }]);
                  // URL mode: open browser for OAuth
                  if (input.mode === 'url' && input.url) {
                    try {
                      const { shell } = require('electron') as typeof import('electron');
                      shell.openExternal(input.url);
                    } catch { /* best effort */ }
                  }
                } catch (err) { console.error('[sessions] Elicitation hook failed:', err); }
                // Accept elicitation so MCP servers can connect
                return { hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept' } };
              },
            ],
          },
        ],

        // ---- #22 ElicitationResult ----
        ElicitationResult: [
          {
            hooks: [
              async (input: any) => {
                try {
                  logging.writeBatch([{
                    timestamp: new Date().toISOString(),
                    level: 'info',
                    source: 'claude-hooks',
                    category: `session:${tabId}`,
                    message: `🔑 elicitation result: ${input.mcp_server_name} → ${input.action}`,
                    metadata: stringifyCapped({ event: 'ElicitationResult', mcp_server_name: input.mcp_server_name, elicitation_id: input.elicitation_id, mode: input.mode, action: input.action, content: input.content }),
                  }]);
                } catch (err) { console.error('[sessions] ElicitationResult hook failed:', err); }
                return {};
              },
            ],
          },
        ],

        // ---- #23 ConfigChange ----
        ConfigChange: [
          {
            hooks: [
              async (input: any) => {
                try {
                  logging.writeBatch([{
                    timestamp: new Date().toISOString(),
                    level: 'info',
                    source: 'claude-hooks',
                    category: `session:${tabId}`,
                    message: `🔧 config changed: ${input.source}${input.file_path ? ` (${input.file_path})` : ''}`,
                    metadata: stringifyCapped({ event: 'ConfigChange', source: input.source, file_path: input.file_path }),
                  }]);
                  sendToRenderer(`claude-output:${tabId}`, {
                    type: 'system', subtype: 'config_change',
                    source: input.source, file_path: input.file_path,
                  });
                } catch (err) { console.error('[sessions] ConfigChange hook failed:', err); }
                return {};
              },
            ],
          },
        ],

        // ---- #26 InstructionsLoaded ----
        InstructionsLoaded: [
          {
            hooks: [
              async (input: any) => {
                try {
                  logging.writeBatch([{
                    timestamp: new Date().toISOString(),
                    level: 'info',
                    source: 'claude-hooks',
                    category: `session:${tabId}`,
                    message: `📄 instructions loaded: ${input.file_path} (${input.memory_type}, ${input.load_reason})`,
                    metadata: stringifyCapped({ event: 'InstructionsLoaded', file_path: input.file_path, memory_type: input.memory_type, load_reason: input.load_reason, globs: input.globs, trigger_file_path: input.trigger_file_path, parent_file_path: input.parent_file_path }),
                  }]);
                  sendToRenderer(`claude-output:${tabId}`, {
                    type: 'system', subtype: 'instructions_loaded',
                    file_path: input.file_path, memory_type: input.memory_type,
                    load_reason: input.load_reason,
                  });
                } catch (err) { console.error('[sessions] InstructionsLoaded hook failed:', err); }
                return {};
              },
            ],
          },
        ],

      };
    }

    // ---- canUseTool: primary permission handler ----
    // Called by the SDK before each tool execution. The SDK may call this
    // concurrently for parallel tool use — we queue requests and show them
    // one at a time so the user isn't overwhelmed.

    options.canUseTool = async (
      toolName: string,
      toolInput: Record<string, unknown>,
      toolOptions: {
        signal: AbortSignal;
        suggestions?: any[];
        blockedPath?: string;
        decisionReason?: string;
        title?: string;
        displayName?: string;
        description?: string;
        toolUseID: string;
        agentID?: string;
      },
    ): Promise<any> => {
      const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      // If the SDK doesn't provide suggestions, generate a sensible default
      // from the tool name and input so the user can still save a rule.
      try { fs.appendFileSync('/tmp/gc-perm-debug.log', `[${new Date().toISOString()}] canUseTool: ${toolName} sdk_suggestions=${JSON.stringify(toolOptions.suggestions)}\n`); } catch {}
      let suggestions = toolOptions.suggestions;
      if (!suggestions || suggestions.length === 0) {
        let ruleContent: string | undefined;
        if (toolName === 'Bash' && typeof toolInput.command === 'string') {
          // Extract the base command for a wildcard rule: "git status" → "git:*"
          const cmd = (toolInput.command as string).trim();
          const base = cmd.split(/[\s;|&]/)[0];
          ruleContent = base ? `${base}:*` : cmd;
        } else if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Read') {
          ruleContent = typeof toolInput.file_path === 'string' ? toolInput.file_path : undefined;
        }
        if (ruleContent) {
          suggestions = [{
            type: 'addRules',
            rules: [{ toolName, ruleContent }],
            behavior: 'allow',
            destination: 'localSettings',
          }];
        }
      }

      const payload = {
        type: 'permission_request',
        request_id: requestId,
        tool_name: toolName,
        tool_input: toolInput,
        title: toolOptions.title,
        display_name: toolOptions.displayName,
        description: toolOptions.description,
        decision_reason: toolOptions.decisionReason,
        blocked_path: toolOptions.blockedPath,
        permission_suggestions: suggestions,
      };

      const decision = await new Promise<PermissionDecision>((resolve) => {
        const entry: PendingPermission & { payload: any } = { requestId, resolve, payload };
        handle.permissionQueue.push(entry);
        // If this is the only item in the queue, show it immediately
        if (handle.permissionQueue.length === 1) {
          handle.status = 'waiting_permission';
          sendToRenderer(`claude-output:${tabId}`, payload);

          // Notify the user that a permission decision is needed
          const projectName = path.basename(handle.projectPath) || 'GreyChrist';
          const title = `GreyChrist — ${projectName}`;
          const body = `Permission requested: ${toolName}`;
          sendToRenderer('claude-notification', { tab_id: tabId, title, body, is_error: false });
          try {
            notificationHooks.showNotification?.(title, body, false);
            notificationHooks.incrementUnread?.();
          } catch (e) {
            console.error('[sessions] permission notification hook failed:', e);
          }
        }
        // Otherwise it waits — sendNextPermission will show it when the current one resolves
      });

      const debugPerm = (msg: string) => {
        try { fs.appendFileSync('/tmp/gc-perm-debug.log', `[${new Date().toISOString()}] ${msg}\n`); } catch {}
      };

      if (decision.behavior === 'allow') {
        // updatedInput is REQUIRED and must be the original tool input
        // (or a modified version). Passing {} breaks the SDK.
        const result: Record<string, unknown> = {
          behavior: 'allow',
          updatedInput: decision.updatedInput ?? toolInput,
        };
        if (decision.updatedPermissions && decision.updatedPermissions.length > 0) {
          result.updatedPermissions = decision.updatedPermissions;
          debugPerm(`ALLOW ${toolName} with ${decision.updatedPermissions.length} permission updates: ${JSON.stringify(decision.updatedPermissions)}`);
        } else {
          debugPerm(`ALLOW ${toolName} (session only, no rules saved)`);
        }

        // Verify save after a short delay — read the target file to confirm
        if (decision.updatedPermissions && decision.updatedPermissions.length > 0) {
          setTimeout(() => {
            for (const perm of decision.updatedPermissions!) {
              try {
                let filePath: string;
                const dest = (perm as any).destination;
                if (dest === 'userSettings') filePath = path.join(handle.configDir, 'settings.json');
                else if (dest === 'projectSettings') filePath = path.join(handle.projectPath, '.claude', 'settings.json');
                else if (dest === 'localSettings') filePath = path.join(handle.projectPath, '.claude', 'settings.local.json');
                else { debugPerm(`VERIFY skip: destination=${dest}`); continue; }
                const content = fs.readFileSync(filePath, 'utf-8');
                const parsed = JSON.parse(content);
                const allow = parsed.permissions?.allow ?? [];
                const ruleStr = ((perm as any).rules ?? []).map((r: any) => r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName).join(', ');
                const found = allow.some((a: string) => ruleStr && a.includes((perm as any).rules?.[0]?.ruleContent ?? ''));
                debugPerm(`VERIFY ${filePath}: looking for "${ruleStr}" → ${found ? 'FOUND' : 'NOT FOUND'} (allow has ${allow.length} rules: ${JSON.stringify(allow)})`);
              } catch (e) {
                debugPerm(`VERIFY error: ${e}`);
              }
            }
          }, 1000);
        }

        return result;
      }

      debugPerm(`DENY ${toolName}`);
      return {
        behavior: 'deny' as const,
        message: 'User denied permission',
      };
    };

    // Use system-installed claude binary (account is scoped via CLAUDE_CONFIG_DIR)
    const binaryPath = findSystemClaudeBinary();
    if (binaryPath) {
      options.pathToClaudeCodeExecutable = binaryPath;
    }

    if (resumeSessionId) {
      options.resume = resumeSessionId;
    }

    // Create handle first so the PermissionRequest hook callback can reference it
    const handle: SessionHandle = {
      query: null as any, // set below
      inputChannel,
      sessionId: null,
      status: 'starting',
      permissionResolver: null,
      permissionQueue: [],
      autoAllowEnabled: false,
      autoAllowedTools: new Set(),
      projectPath,
      configDir: configDir || path.join(os.homedir(), '.claude'),
      sdkOptions: options,
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

    // If the previous stream errored, restart the SDK query transparently
    if (handle.status === 'error') {
      restartQuery(tabId, handle);
    }

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

    // If the previous stream errored, restart the SDK query transparently
    if (handle.status === 'error') {
      restartQuery(tabId, handle);
    }

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
    updatedPermissions?: PermissionDecision['updatedPermissions'],
  ): void {
    const handle = sessions.get(tabId);
    if (!handle || handle.permissionQueue.length === 0) return;

    // Resolve the front of the queue
    const current = handle.permissionQueue.shift()!;
    current.resolve({ behavior, updatedInput, updatedPermissions });

    // Show the next queued request, if any
    if (handle.permissionQueue.length > 0) {
      const next = handle.permissionQueue[0];
      const nextPayload = (next as any).payload;
      sendToRenderer(`claude-output:${tabId}`, nextPayload);

      // Notify the user about the next permission in the queue
      const projectName = path.basename(handle.projectPath) || 'GreyChrist';
      const title = `GreyChrist — ${projectName}`;
      const body = `Permission requested: ${nextPayload.tool_name}`;
      sendToRenderer('claude-notification', { tab_id: tabId, title, body, is_error: false });
      try {
        notificationHooks.showNotification?.(title, body, false);
        notificationHooks.incrementUnread?.();
      } catch (e) {
        console.error('[sessions] permission notification hook failed:', e);
      }
    } else {
      handle.status = 'running';
    }
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

  async function setEffort(tabId: string, level: 'low' | 'medium' | 'high' | 'max' | null): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) return;
    try {
      await handle.query.applyFlagSettings({ effortLevel: level ?? undefined } as any);
    } catch (err) {
      console.error(`[sessions] setEffort failed for tab ${tabId}:`, err);
    }
  }

  async function setThinking(tabId: string, config: SessionStartParams['thinking']): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) return;
    try {
      if (!config || config.type === 'disabled') {
        await handle.query.setMaxThinkingTokens(0);
      } else if (config.type === 'adaptive') {
        await handle.query.setMaxThinkingTokens(null);
      } else if (config.type === 'enabled') {
        await handle.query.setMaxThinkingTokens(config.budgetTokens ?? null);
      }
    } catch (err) {
      console.error(`[sessions] setThinking failed for tab ${tabId}:`, err);
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

  async function getMcpServerStatus(tabId: string): Promise<McpServerStatus[]> {
    const handle = sessions.get(tabId);
    if (!handle) return [];

    // Ask the SDK for live MCP server status (includes tools, versions, scopes).
    // Times out after 3s so the panel doesn't hang if the session is still starting.
    try {
      const result = await Promise.race([
        handle.query.mcpServerStatus(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (result && result.length > 0) return result;
    } catch { /* SDK not ready */ }

    return [];
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
    setEffort,
    setThinking,
    getAccountInfo,
    getContextUsage,
    getSupportedCommands,
    getSupportedModels,
    getSupportedAgents,
    getMcpServerStatus,
  };
}
