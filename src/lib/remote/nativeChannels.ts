/**
 * Channels the native app serves, never the daemon. One list, three readers: the daemon's rpc allowlist, the shim, and NativeChannels.swift. Pure data, no imports.
 * Only what needs the machine the window is on belongs here; anything headless lives in the daemon, where the iPad reaches it.
 */

export const NATIVE_INVOKE_CHANNELS: readonly string[] = [
  'dialog:open',
  'dialog:save',
  'shell:openExternal',
  'shell:listBrowsers',
  'reveal_path_in_finder',
  'open_path',
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
  'tab_status_publish',
  'tab_status_remove',
  'tab_status_list',
  'remote:url',
  'remote:restart',
  'notify:show',
  'notify:remove',
  /** WebKit gives plain http no async clipboard. */
  'clipboard:write',
  /** WebKit gives the page a dropped file's bytes, never its path. */
  'drop:paths',
];

export const NATIVE_EVENT_PREFIXES: readonly string[] = [
  'updater:',
  'notification-clicked',
  'tab-status:',
  // The app sees the lock screen; the daemon never does.
  'system-power-state',
  // Derived from tab statuses the app aggregates; the daemon never sends it.
  'session-inflight-count',
];

export function isNativeEventChannel(channel: string): boolean {
  return NATIVE_EVENT_PREFIXES.some((p) => channel === p || channel.startsWith(p));
}
