import type { JsonlNode } from '@/types/jsonl';

// Live-only: `system/permission_check_status` (CLI 2.1.292) is never written to disk.

export type PermissionCheckStatus = 'checking' | 'done';

export interface PermissionCheckFrame {
  toolUseId: string;
  status: PermissionCheckStatus;
}

export type PermissionChecks = ReadonlySet<string>;

export const EMPTY_PERMISSION_CHECKS: PermissionChecks = new Set<string>();

export function permissionCheckFrame(node: JsonlNode): PermissionCheckFrame | null {
  if (node.kind !== 'system' || node.subtype !== 'permission_check_status') return null;
  const raw = node.raw as { tool_use_id?: unknown; status?: unknown };
  if (typeof raw.tool_use_id !== 'string') return null;
  if (raw.status !== 'checking' && raw.status !== 'done') return null;
  return { toolUseId: raw.tool_use_id, status: raw.status };
}

/** Reference-stable: a frame that changes nothing returns `prev`. */
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
