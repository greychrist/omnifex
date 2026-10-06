import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import {
  EMPTY_PERMISSION_CHECKS,
  permissionCheckFrame,
  reducePermissionCheck,
} from '../permissionChecks';

const frame = (raw: Record<string, unknown>): JsonlNode =>
  ({
    kind: 'system', subtype: 'permission_check_status', sessionId: '', receivedAt: '',
    raw: { type: 'system', subtype: 'permission_check_status', ...raw },
  }) as unknown as JsonlNode;

describe('permissionCheckFrame', () => {
  it('reads tool_use_id and status off a permission_check_status frame', () => {
    expect(permissionCheckFrame(frame({ tool_use_id: 'toolu_1', status: 'checking' })))
      .toEqual({ toolUseId: 'toolu_1', status: 'checking' });
    expect(permissionCheckFrame(frame({ tool_use_id: 'toolu_1', status: 'done' })))
      .toEqual({ toolUseId: 'toolu_1', status: 'done' });
  });

  it('is null for any other node, and for a frame it cannot read', () => {
    const other = { kind: 'system', subtype: 'status', sessionId: '', receivedAt: '', raw: { type: 'system', subtype: 'status' } } as unknown as JsonlNode;
    expect(permissionCheckFrame(other)).toBeNull();
    expect(permissionCheckFrame(frame({ status: 'checking' }))).toBeNull();
    expect(permissionCheckFrame(frame({ tool_use_id: 'toolu_1', status: 'later' }))).toBeNull();
  });
});

describe('reducePermissionCheck', () => {
  it('adds a call on checking and drops it on done', () => {
    const checking = reducePermissionCheck(EMPTY_PERMISSION_CHECKS, { toolUseId: 'a', status: 'checking' });
    expect([...checking]).toEqual(['a']);
    const done = reducePermissionCheck(checking, { toolUseId: 'a', status: 'done' });
    expect(done.size).toBe(0);
  });

  it('keeps the reference when nothing changed, so a replayed frame costs no render', () => {
    const checking = reducePermissionCheck(EMPTY_PERMISSION_CHECKS, { toolUseId: 'a', status: 'checking' });
    expect(reducePermissionCheck(checking, { toolUseId: 'a', status: 'checking' })).toBe(checking);
    expect(reducePermissionCheck(EMPTY_PERMISSION_CHECKS, { toolUseId: 'a', status: 'done' }))
      .toBe(EMPTY_PERMISSION_CHECKS);
  });

  it('tracks parallel calls independently', () => {
    let s = reducePermissionCheck(EMPTY_PERMISSION_CHECKS, { toolUseId: 'a', status: 'checking' });
    s = reducePermissionCheck(s, { toolUseId: 'b', status: 'checking' });
    s = reducePermissionCheck(s, { toolUseId: 'a', status: 'done' });
    expect([...s]).toEqual(['b']);
  });
});
