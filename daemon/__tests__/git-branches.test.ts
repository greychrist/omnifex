import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { listBranches } from '../services/git-branches';

describe('listBranches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gc-git-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] for non-git directories', async () => {
    expect(await listBranches(dir)).toEqual([]);
  });

  it('returns the local branch names sorted', async () => {
    execSync('git init -q -b main', { cwd: dir });
    execSync('git config user.email t@t', { cwd: dir });
    execSync('git config user.name t', { cwd: dir });
    execSync('git commit --allow-empty -q -m initial', { cwd: dir });
    execSync('git branch develop', { cwd: dir });
    execSync('git branch feature/x', { cwd: dir });
    expect(await listBranches(dir)).toEqual(['develop', 'feature/x', 'main']);
  });
});
