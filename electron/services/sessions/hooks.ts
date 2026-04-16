// Sessions module — SDK hooks factory
// Extracted from electron/services/sessions.ts (pure refactor)

import type { LoggingService, SendToRenderer, NotificationHooks } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const METADATA_CAP = 4000;

export const stringifyCapped = (obj: unknown): string => {
  try {
    const s = JSON.stringify(obj);
    if (s.length <= METADATA_CAP) return s;
    return s.slice(0, METADATA_CAP - 20) + '…[truncated]';
  } catch {
    return '"[unserializable]"';
  }
};

// ---------------------------------------------------------------------------
// createSessionHooks
// ---------------------------------------------------------------------------

export function createSessionHooks(
  tabId: string,
  logging: LoggingService | null,
  sendToRenderer: SendToRenderer,
  notificationHooks: NotificationHooks,
): Record<string, unknown> {
  if (!logging) return {};

  return {
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
    // Logging only — the actual user prompt is handled by onElicitation in lifecycle.ts
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
            } catch (err) { console.error('[sessions] Elicitation hook failed:', err); }
            // Do NOT return an action — let onElicitation handle the user prompt
            return {};
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
