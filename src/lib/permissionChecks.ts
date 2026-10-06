import type { JsonlNode } from '@/types/jsonl';

/**
 * Tool calls waiting on their automatic permission check, live-only.
 *
 * CLI 2.1.292 sends `system/permission_check_status` on stream-json stdout
 * once a call has waited ~4 s on its check (auto mode's classifier):
 * `checking`, then `done` when the wait is over. Never written to disk, so
 * like `tool_progress` it is reduced into a per-tab slot and read at render
 * time — the tool row's chip and the status bar's `perms` readout.
 */

export type PermissionCheckStatus = 'checking' | 'done';

export interface PermissionCheckFrame {
  toolUseId: string;
  status: PermissionCheckStatus;
}

export type PermissionChecks = ReadonlySet<string>;

export const EMPTY_PERMISSION_CHECKS: PermissionChecks = new Set<string>();

/** The frame a node carries, or null for any other node. */
export function permissionCheckFrame(node: JsonlNode): PermissionCheckFrame | null {
  if (node.kind !== 'system' || node.subtype !== 'permission_check_status') return null;
  const raw = node.raw as { tool_use_id?: unknown; status?: unknown };
  if (typeof raw.tool_use_id !== 'string') return null;
  if (raw.status !== 'checking' && raw.status !== 'done') return null;
  return { toolUseId: raw.tool_use_id, status: raw.status };
}

/**
 * Fold one frame in. Reference-stable: a frame that changes nothing returns
 * `prev`, so a replayed delivery cannot cost a render.
 */
export function reducePermissionCheck(
  prev: PermissionChecks,
  frame: PermissionCheckFrame,
): PermissionChecks {
  const has = prev.has(frame.toolUseId);
  if (frame.status === 'checking' ? has : !has) return prev;
  const next = new Set(prev);
  if (frame.status === 'checking') next.add(frame.toolUseId);
  else next.delete(frame.toolUseId);
  return next;
}
