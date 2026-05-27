import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

// Allow-lists for IPC channel security.
const ALLOWED_INVOKE_CHANNELS = new Set([
  // Accounts
  'list_accounts',
  'create_account',
  'update_account',
  'update_account_summary',
  'delete_account',
  'list_path_rules',
  'add_path_rule',
  'remove_path_rule',
  'resolve_account_for_project',
  'set_project_account_override',
  'list_project_overrides',
  'discover_accounts',
  'scan_for_new_accounts',
  'explain_account_resolution',

  // Claude
  'list_projects',
  'create_project',
  'get_project_sessions',
  'load_session_history',
  'delete_session',
  'delete_project',
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
  'session_rebind',
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
  'list_supported_models',
  'session_mcp_server_status',
  'session_plugins',
  'session_get_permissions',
  'session_update_permission',
  'session_set_mode',
  'session_tui_write',
  'session_tui_resize',

  // Usage
  'get_usage_stats',
  'get_usage_by_date_range',
  'get_session_stats',
  'get_usage_details',
  'get_usage_by_account',

  // Rate Limits
  'get_rate_limits',
  'get_rate_limit_settings',
  'update_rate_limit_settings',

  // Usage CLI Runner
  'usage_run_cli',
  'usage_get_last',
  'accounts_validate_cli_path',

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

  // Session Summaries
  'summary_get',
  'summary_generate',
  'summary_generating_now',

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
  'preview_notification_sound',

  // Branch colors
  'branch_colors_list',
  'branch_colors_upsert',
  'branch_colors_delete',

  // Git
  'get_git_branch',
  'list_git_worktrees',
  'start_session_git_watch',
  'stop_session_git_watch',
  'reconnect_session_git_watch',
  'git_list_branches',

  // Lima (VM viewer)
  'lima_check_installed',
  'lima_list_vms',
  'lima_list_containers',
  'lima_start_vm',
  'lima_stop_vm',
  'lima_start_container',
  'lima_stop_container',

  // Filesystem (FilePicker @-mention browser)
  'list_directory_contents',
  'search_files',
  'fs_exists',

  // Proxy
  'get_proxy_settings',
  'save_proxy_settings',

  // Tab Status (renderer publishes per-tab summaries; popover reads list)
  'tab_status_publish',
  'tab_status_remove',
  'tab_status_list',

  // One-shot terminal (shared pty+xterm modal — Codex login, etc.)
  'one_shot_terminal_spawn',
  'one_shot_terminal_write',
  'one_shot_terminal_resize',
  'one_shot_terminal_kill',

  // Codex auth (read ~/.codex/auth.json + drive `codex login` via OneShotTerminal)
  'codex_auth_status',
  'codex_auth_start_login',
  'codex_auth_cancel_login',

  // Updater
  'updater:check',
  'updater:download',
  'updater:open',
  'updater:install',
  'updater:install-cancel',

  // Electron-specific
  'dialog:open',
  'dialog:save',
  'save_pasted_image',
  'shell:openExternal',
  'reveal_path_in_finder',
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
      !channel.startsWith('claude-output:') &&
      !channel.startsWith('claude-output-extra:') &&
      !channel.startsWith('claude-error:') &&
      !channel.startsWith('claude-complete:') &&
      !channel.startsWith('claude-notification') &&
      !channel.startsWith('claude-stream') &&
      !channel.startsWith('claude-subagent:') &&
      !channel.startsWith('claude-compact:') &&
      !channel.startsWith('elicitation-request:') &&
      !channel.startsWith('backend-log') &&
      !channel.startsWith('updater:') &&
      !channel.startsWith('notification-clicked') &&
      !channel.startsWith('session-git-changed:') &&
      !channel.startsWith('rate-limits:') &&
      !channel.startsWith('tab-status:') &&
      !channel.startsWith('one-shot-terminal-data:') &&
      !channel.startsWith('one-shot-terminal-exit:') &&
      !channel.startsWith('codex-auth-status-changed') &&
      channel !== 'log-error'
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
