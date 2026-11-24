import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { createBranchColorsService, type BranchColorsService } from '../services/branch-colors';

describe('branchColors service', () => {
  let db: Database;
  let svc: BranchColorsService;
  let send: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => void>>;

  beforeEach(() => {
    db = createDatabase(':memory:');
    send = vi.fn<(channel: string, ...args: unknown[]) => void>();
    svc = createBranchColorsService(db, { sendToRenderer: send });
  });

  afterEach(() => {
    db.close();
  });

  it('lists empty for a fresh project', () => {
    expect(svc.listForRepo('/p')).toEqual([]);
  });

  it('upserts a new pin', () => {
    const created = svc.upsert({ repo_path: '/p', branch_name: 'develop', color: '#3b82f6' });
    expect(created.id).toBeGreaterThan(0);
    expect(created.color).toBe('#3b82f6');
    expect(svc.listForRepo('/p')).toHaveLength(1);
  });

  it('upsert replaces color when (repo_path, branch_name) already exists', () => {
    svc.upsert({ repo_path: '/p', branch_name: 'develop', color: '#3b82f6' });
    const updated = svc.upsert({ repo_path: '/p', branch_name: 'develop', color: '#10b981' });
    expect(updated.color).toBe('#10b981');
    expect(svc.listForRepo('/p')).toHaveLength(1);
  });

  it('returns rows ordered by sort_order then id', () => {
    svc.upsert({ repo_path: '/p', branch_name: 'a', color: '#3b82f6' });
    svc.upsert({ repo_path: '/p', branch_name: 'b', color: '#10b981' });
    svc.upsert({ repo_path: '/p', branch_name: 'c', color: '#ef4444' });
    expect(svc.listForRepo('/p').map((r) => r.branch_name)).toEqual(['a', 'b', 'c']);
  });

  it('deletes by id and returns true on success', () => {
    const row = svc.upsert({ repo_path: '/p', branch_name: 'develop', color: '#3b82f6' });
    expect(svc.delete(row.id)).toBe(true);
    expect(svc.listForRepo('/p')).toHaveLength(0);
  });

  it('delete returns false when row does not exist', () => {
    expect(svc.delete(999)).toBe(false);
  });

  it('isolates rows by repo_path', () => {
    svc.upsert({ repo_path: '/p1', branch_name: 'develop', color: '#3b82f6' });
    svc.upsert({ repo_path: '/p2', branch_name: 'develop', color: '#10b981' });
    expect(svc.listForRepo('/p1')).toHaveLength(1);
    expect(svc.listForRepo('/p2')).toHaveLength(1);
    expect(svc.listForRepo('/p1')[0].color).toBe('#3b82f6');
  });

  it('broadcasts branch-colors-changed with the repo on upsert and delete', () => {
    const row = svc.upsert({ repo_path: '/p', branch_name: 'develop', color: '#3b82f6' });
    expect(send).toHaveBeenLastCalledWith('branch-colors-changed', { repoPath: '/p' });
    send.mockClear();
    svc.delete(row.id);
    expect(send).toHaveBeenLastCalledWith('branch-colors-changed', { repoPath: '/p' });
  });

  it('keys a linked worktree by its main checkout', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-bc-')));
    try {
      const repo = path.join(root, 'r');
      fs.mkdirSync(repo);
      execSync('git init -q -b main && git -c user.email=t@e -c user.name=T commit -q --allow-empty -m i', { cwd: repo, stdio: 'pipe', shell: '/bin/sh' });
      const wt = path.join(root, 'wt');
      execSync(`git worktree add -q -b wt ${wt}`, { cwd: repo, stdio: 'pipe' });
      svc.upsert({ repo_path: wt, branch_name: 'feat', color: '#111111' });
      expect(svc.listForRepo(repo)).toHaveLength(1);
      expect(svc.listForRepo(wt)).toHaveLength(1);
      expect(svc.listForRepo(repo)[0].repo_path).toBe(repo);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
