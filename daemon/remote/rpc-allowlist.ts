// Hiding admin UI in the client is not a boundary; this list is. It subtracts from INVOKE_CHANNELS, so a new
// channel is reachable unless denied. Typed session channels stay out: as rpc they would bypass the project registry.

import { NATIVE_INVOKE_CHANNELS } from '../../src/lib/remote/nativeChannels';

export const NATIVE_ONLY_CHANNELS: readonly string[] = NATIVE_INVOKE_CHANNELS;

export const TYPED_SESSION_CHANNELS: readonly string[] = [
  'session_start',
  'session_rebind',
  'session_send_message',
  'session_send_structured_message',
  'session_respond_permission',
  'session_stop',
  'session_release',
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
    ...NATIVE_ONLY_CHANNELS,
    ...TYPED_SESSION_CHANNELS,
    ...RAW_DATABASE_CHANNELS,
    ...(overrides.deny ?? []),
  ]);
  const out = new Set<string>();
  for (const ch of invokeChannels) if (!denied.has(ch)) out.add(ch);
  for (const ch of overrides.allow ?? []) {
    if (!(overrides.deny ?? []).includes(ch)) out.add(ch);
  }
  return out;
}
