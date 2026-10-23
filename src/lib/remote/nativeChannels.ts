/**
 * IPC channels the native macOS app serves, never the daemon.
 *
 * One list, three readers: the daemon's `rpc.invoke` allowlist removes these
 * (`electron/remote/rpc-allowlist.ts`), the renderer-side shim routes them to
 * the native bridge instead of the daemon (`src/lib/remote/electronApiShim.ts`),
 * and the Swift app routes exactly these (`macos/Sources/OmniFexCore/
 * NativeChannels.swift`, held to this list by `native-channels-swift.test.ts`).
 * Kept here, on the shared side of the process boundary, so they cannot drift.
 *
 * What belongs here is what needs the machine the window is on — a display,
 * Finder, the dock, the notification centre, the app bundle. Anything that can
 * run headless lives in the daemon, where the iPad reaches it too: the sign-in
 * pty, the identity watchers and pasted-image storage all moved there when the
 * Electron shell was replaced (2026-10-23).
 *
 * Pure data — no imports — so every side can load it.
 */

/** `invoke()` channels served by the native app, never the daemon. */
export const NATIVE_INVOKE_CHANNELS: readonly string[] = [
  'dialog:open',
  'dialog:save',
  'shell:openExternal',
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
  /** Where the daemon is. Answered by the app, which started it. */
  'remote:url',
  /** Stop the daemon and start this build's. The app owns the process. */
  'remote:restart',
  /** OS notification on behalf of a daemon-side event. */
  'notify:show',
  /** The page is plain http, which WebKit gives no async clipboard. */
  'clipboard:write',
];

/**
 * Event channels (by exact name or prefix) that originate in the native app.
 * Everything else the renderer subscribes to comes from the daemon.
 */
export const NATIVE_EVENT_PREFIXES: readonly string[] = [
  'updater:',
  'notification-clicked',
  'tab-status:',
  // The app sees the lock screen; the daemon never does.
  'system-power-state',
  // Derived from the tab statuses the app aggregates. Listed so the shim
  // routes it to the bridge: while it was missing here the titlebar's
  // "N sessions working" warning listened on the daemon, which never sends it.
  'session-inflight-count',
];

export function isNativeEventChannel(channel: string): boolean {
  return NATIVE_EVENT_PREFIXES.some((p) => channel === p || channel.startsWith(p));
}
