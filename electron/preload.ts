import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

// Allow-lists for IPC channel security.
const ALLOWED_INVOKE_CHANNELS = new Set([
  // Accounts
  'list_accounts',
  'create_account',
  'update_account',
  'delete_account',
  'list_path_rules',
  'add_path_rule',
  'remove_path_rule',
  'resolve_account_for_project',
  'set_project_account_override',
  'list_project_overrides',
  'discover_accounts',
  'explain_account_resolution',

  // Claude
  'list_projects',
  'create_project',
  'get_project_sessions',
  'load_session_history',
  'load_agent_session_history',
  'get_home_directory',
  'get_claude_settings',
  'save_claude_settings',
  'get_system_prompt',
  'save_system_prompt',
  'check_claude_version',
  'get_cli_usage',
  'find_claude_md_files',
  'read_claude_md_file',
  'save_claude_md_file',
  'get_hooks_config',
  'update_hooks_config',
  'validate_hook_command',
  'get_merged_hooks_config',

  // Sessions
  'session_start',
  'session_send_message',
  'session_send_structured_message',
  'session_respond_permission',
  'session_respond_elicitation',
  'session_stop',
  'session_get_info',
  'session_get_health',
  // Wave 2 — Query-method passthroughs
  'session_interrupt',
  'session_set_model',
  'session_set_permission_mode',
  'session_set_effort',
  'session_set_thinking',
  'session_account_info',
  'session_context_usage',
  'session_supported_commands',
  'session_supported_models',
  'session_supported_agents',
  'session_mcp_server_status',
  'session_get_permissions',
  'session_update_permission',

  // Agents
  'list_agents',
  'list_running_sessions',
  'create_agent',
  'update_agent',
  'delete_agent',
  'get_agent',
  'export_agent',
  'import_agent',
  'execute_agent',
  'list_agent_runs',
  'get_agent_run',
  'get_agent_run_with_real_time_metrics',
  'kill_agent_session',
  'get_session_status',
  'cleanup_finished_processes',
  'get_session_output',
  'get_live_session_output',
  'stream_session_output',
  'fetch_github_agents',
  'fetch_github_agent_content',
  'import_agent_from_github',

  // Usage
  'get_usage_stats',
  'get_usage_by_date_range',
  'get_session_stats',
  'get_usage_details',
  'get_usage_by_account',

  // Checkpoints
  'create_checkpoint',
  'restore_checkpoint',
  'list_checkpoints',
  'fork_from_checkpoint',
  'get_session_timeline',
  'update_checkpoint_settings',
  'get_checkpoint_settings',
  'get_checkpoint_diff',
  'clear_checkpoint_manager',

  // Claude Binary
  'get_claude_binary_path',
  'set_claude_binary_path',
  'list_claude_installations',

  // MCP
  'mcp_add',
  'mcp_list',
  'mcp_get',
  'mcp_remove',
  'mcp_add_json',
  'mcp_add_from_claude_desktop',
  'mcp_serve',
  'mcp_test_connection',
  'mcp_reset_project_choices',
  'mcp_get_server_status',
  'mcp_read_project_config',
  'mcp_save_project_config',

  // Slash Commands
  'slash_commands_list',
  'slash_command_get',
  'slash_command_save',
  'slash_command_delete',

  // Logging
  'log_write_batch',
  'log_query',
  'log_count',
  'log_prune',

  // Storage
  'storage_list_tables',
  'storage_read_table',
  'storage_update_row',
  'storage_delete_row',
  'storage_insert_row',
  'storage_execute_sql',
  'storage_reset_database',
  'get_setting',
  'save_setting',

  // Git
  'get_git_branch',

  // Proxy
  'get_proxy_settings',
  'save_proxy_settings',

  // Updater
  'updater:check',
  'updater:download',
  'updater:open',

  // Electron-specific
  'dialog:open',
  'dialog:save',
  'save_pasted_image',
  'shell:openExternal',
  'get_app_version',
  'window:minimize',
  'window:maximize',
  'window:close',
]);

const ALLOWED_EVENT_CHANNELS = new Set<string>([]);

export function addAllowedInvokeChannels(...channels: string[]): void {
  for (const ch of channels) ALLOWED_INVOKE_CHANNELS.add(ch);
}

export function addAllowedEventChannels(...channels: string[]): void {
  for (const ch of channels) ALLOWED_EVENT_CHANNELS.add(ch);
}

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (!ALLOWED_INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, params);
  },

  onEvent: (channel: string, callback: (...args: unknown[]) => void): (() => void) => {
    if (
      !ALLOWED_EVENT_CHANNELS.has(channel) &&
      !channel.startsWith('session-') &&
      !channel.startsWith('agent-output:') &&
      !channel.startsWith('agent-error:') &&
      !channel.startsWith('agent-complete:') &&
      !channel.startsWith('agent-cancelled:') &&
      !channel.startsWith('claude-output:') &&
      !channel.startsWith('claude-error:') &&
      !channel.startsWith('claude-complete:') &&
      !channel.startsWith('claude-notification') &&
      !channel.startsWith('claude-stream') &&
      !channel.startsWith('claude-subagent:') &&
      !channel.startsWith('claude-compact:') &&
      !channel.startsWith('elicitation-request:') &&
      !channel.startsWith('backend-log') &&
      !channel.startsWith('updater:')
    ) {
      throw new Error(`Blocked IPC event channel: ${channel}`);
    }
    const listener = (_event: IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  showOpenDialog: (options: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('dialog:open', options),

  showSaveDialog: (options: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('dialog:save', options),

  openExternal: (url: string): Promise<void> => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return Promise.reject(new Error('Unsafe protocol'));
    }
    return ipcRenderer.invoke('shell:openExternal', url);
  },
});
