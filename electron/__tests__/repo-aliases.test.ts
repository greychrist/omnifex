import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createRepoAliasesService, type RepoAliasesService } from '../services/repo-aliases';

describe('repo aliases service', () => {
  let db: Database;
  let svc: RepoAliasesService;
  let send: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => void>>;

  beforeEach(() => {
    db = createDatabase(':memory:');
    send = vi.fn<(channel: string, ...args: unknown[]) => void>();
    svc = createRepoAliasesService(db, { sendToRenderer: send });
  });
  afterEach(() => { db.close(); });

  it('has no alias until one is set', () => {
    expect(svc.list(['/r'])).toEqual({});
  });

  it('sets, trims and announces an alias, keyed by the path asked for', () => {
    svc.set('/r', '  backend ');
    expect(svc.list(['/r', '/other'])).toEqual({ '/r': 'backend' });
    expect(send).toHaveBeenLastCalledWith('repo-aliases-changed', { repoPath: '/r' });
  });

  it('clears an alias set to blank', () => {
    svc.set('/r', 'backend');
    svc.set('/r', '   ');
    expect(svc.list(['/r'])).toEqual({});
  });

  it('shares one alias between a repo and its linked worktrees', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-alias-')));
    try {
      const repo = path.join(root, 'r');
      fs.mkdirSync(repo);
      execSync('git init -q -b main && git -c user.email=t@e -c user.name=T commit -q --allow-empty -m i', { cwd: repo, stdio: 'pipe', shell: '/bin/sh' });
      const wt = path.join(root, 'wt');
      execSync(`git worktree add -q -b wt ${wt}`, { cwd: repo, stdio: 'pipe' });
      svc.set(wt, 'backend');
      expect(svc.list([repo, wt])).toEqual({ [repo]: 'backend', [wt]: 'backend' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
