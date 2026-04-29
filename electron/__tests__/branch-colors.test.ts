import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createBranchColorsService, type BranchColorsService } from '../services/branch-colors';

describe('branchColors service', () => {
  let db: Database;
  let svc: BranchColorsService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    svc = createBranchColorsService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('lists empty for a fresh project', () => {
    expect(svc.listForProject('/p')).toEqual([]);
  });

  it('upserts a new pin', () => {
    const created = svc.upsert({ project_path: '/p', branch_name: 'develop', color: '#3b82f6' });
    expect(created.id).toBeGreaterThan(0);
    expect(created.color).toBe('#3b82f6');
    expect(svc.listForProject('/p')).toHaveLength(1);
  });

  it('upsert replaces color when (project_path, branch_name) already exists', () => {
    svc.upsert({ project_path: '/p', branch_name: 'develop', color: '#3b82f6' });
    const updated = svc.upsert({ project_path: '/p', branch_name: 'develop', color: '#10b981' });
    expect(updated.color).toBe('#10b981');
    expect(svc.listForProject('/p')).toHaveLength(1);
  });

  it('returns rows ordered by sort_order then id', () => {
    svc.upsert({ project_path: '/p', branch_name: 'a', color: '#3b82f6' });
    svc.upsert({ project_path: '/p', branch_name: 'b', color: '#10b981' });
    svc.upsert({ project_path: '/p', branch_name: 'c', color: '#ef4444' });
    expect(svc.listForProject('/p').map((r) => r.branch_name)).toEqual(['a', 'b', 'c']);
  });

  it('deletes by id and returns true on success', () => {
    const row = svc.upsert({ project_path: '/p', branch_name: 'develop', color: '#3b82f6' });
    expect(svc.delete(row.id)).toBe(true);
    expect(svc.listForProject('/p')).toHaveLength(0);
  });

  it('delete returns false when row does not exist', () => {
    expect(svc.delete(999)).toBe(false);
  });

  it('isolates rows by project_path', () => {
    svc.upsert({ project_path: '/p1', branch_name: 'develop', color: '#3b82f6' });
    svc.upsert({ project_path: '/p2', branch_name: 'develop', color: '#10b981' });
    expect(svc.listForProject('/p1')).toHaveLength(1);
    expect(svc.listForProject('/p2')).toHaveLength(1);
    expect(svc.listForProject('/p1')[0].color).toBe('#3b82f6');
  });
});
