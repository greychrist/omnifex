/**
 * Which IPC channels `rpc.invoke` may reach.
 *
 * The client can hide admin UI; that is not a boundary. This list is. It
 * starts from the renderer's own invoke allow-list (`INVOKE_CHANNELS`) and
 * removes three groups:
 *
 *  1. Electron-only channels — dialogs, shell, window chrome, the updater,
 *     PDF printing, pty-backed terminals. They need a BrowserWindow or a
 *     display and have no meaning in a headless daemon.
 *  2. Session lifecycle channels that have a typed protocol method. Letting
 *     `session_start` through as an rpc would accept a raw path from the
 *     network and bypass the project registry, which exists precisely so
 *     that cannot happen.
 *  3. Raw database writes. `storage_execute_sql` is dev-only even in the
 *     desktop app; the row editors are one bad tap from data loss and have no
 *     place on an iPad.
 *
 * `~/.omnifex/server.json` can widen (`rpcAllow`) or narrow (`rpcDeny`) this
 * per machine — the config is the user's, and so is the risk.
 */

import { NATIVE_INVOKE_CHANNELS } from '../../src/lib/remote/nativeChannels';

/**
 * Shared with the renderer shim (`src/lib/remote/nativeChannels.ts`) so the
 * daemon's deny list and the client's native-routing list are one list.
 */
export const ELECTRON_ONLY_CHANNELS: readonly string[] = NATIVE_INVOKE_CHANNELS;

/** Reached through `session.*` / `turn.*` / `permission.*` instead. */
export const TYPED_SESSION_CHANNELS: readonly string[] = [
  'session_start',
  'session_rebind',
  'session_send_message',
  'session_send_structured_message',
  'session_respond_permission',
  'session_stop',
  'session_interrupt',
];

export const RAW_DATABASE_CHANNELS: readonly string[] = [
  'storage_update_row',
  'storage_delete_row',
  'storage_insert_row',
  'storage_execute_sql',
  'storage_reset_database',
];

export interface RpcAllowlistOverrides {
  allow?: readonly string[];
  deny?: readonly string[];
}

export function buildRpcAllowlist(
  invokeChannels: readonly string[],
  overrides: RpcAllowlistOverrides = {},
): Set<string> {
  const denied = new Set<string>([
    ...ELECTRON_ONLY_CHANNELS,
    ...TYPED_SESSION_CHANNELS,
    ...RAW_DATABASE_CHANNELS,
    ...(overrides.deny ?? []),
  ]);
  const out = new Set<string>();
  for (const ch of invokeChannels) if (!denied.has(ch)) out.add(ch);
  // Explicit allows win over the built-in denies but not over the user's own
  // `rpcDeny`: a channel named in both lists stays out.
  for (const ch of overrides.allow ?? []) {
    if (!(overrides.deny ?? []).includes(ch)) out.add(ch);
  }
  return out;
}
