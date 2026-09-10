/**
 * IPC channels that only make sense inside Electron.
 *
 * One list, two readers: the daemon's `rpc.invoke` allowlist removes these
 * (`electron/remote/rpc-allowlist.ts`), and the renderer-side shim routes
 * them to the preload bridge instead of the daemon
 * (`src/lib/remote/electronApiShim.ts`). Kept here, on the shared side of the
 * process boundary, so the two cannot drift apart.
 *
 * Pure data — no imports — so both sides can load it.
 */

/** `invoke()` channels served by the Electron main process, never the daemon. */
export const NATIVE_INVOKE_CHANNELS: readonly string[] = [
  'dialog:open',
  'dialog:save',
  'shell:openExternal',
  'reveal_path_in_finder',
  'save_pasted_image',
  'window:minimize',
  'window:maximize',
  'window:close',
  'get_app_version',
  'updater:check',
  'updater:download',
  'updater:open',
  'updater:install',
  'updater:install-cancel',
  'cost_report_export_pdf',
  'cost_report_print_ready',
  'preview_notification_sound',
  'one_shot_terminal_spawn',
  'one_shot_terminal_write',
  'one_shot_terminal_resize',
  'one_shot_terminal_kill',
  'codex_auth_start_login',
  'codex_auth_cancel_login',
  'tab_status_publish',
  'tab_status_remove',
  'tab_status_list',
  /** Where the daemon is, and whether to use it. Answered by main only. */
  'remote:url',
  /** OS notification on behalf of a daemon-side event. */
  'notify:show',
];

/**
 * Event channels (by exact name or prefix) that originate in the Electron
 * main process. Everything else the renderer subscribes to comes from the
 * daemon once the shim is installed.
 */
export const NATIVE_EVENT_PREFIXES: readonly string[] = [
  'updater:',
  'notification-clicked',
  'one-shot-terminal-data:',
  'one-shot-terminal-exit:',
  'tab-status:',
  'codex-auth-status-changed',
  'account-identity-changed',
];

export function isNativeEventChannel(channel: string): boolean {
  return NATIVE_EVENT_PREFIXES.some((p) => channel === p || channel.startsWith(p));
}
