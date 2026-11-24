import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverRepos, repoIdentity } from '../services/git-repos';

const dirs: string[] = [];

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-git-repos-')));
  dirs.push(d);
  return d;
}

function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init -q -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git -c user.email=t@e -c user.name=T commit -q --allow-empty -m init', { cwd: dir, stdio: 'pipe' });
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('repoIdentity', () => {
  it('is the realpath of a plain repo', () => {
    const r = initRepo(path.join(tmp(), 'r'));
    expect(repoIdentity(r)).toBe(r);
  });

  it('resolves a linked worktree to its main checkout', () => {
    const root = tmp();
    const r = initRepo(path.join(root, 'r'));
    execSync(`git worktree add -q -b wt ${path.join(root, 'wt')}`, { cwd: r, stdio: 'pipe' });
    expect(repoIdentity(path.join(root, 'wt'))).toBe(r);
  });

  it('is null for a plain directory', () => {
    expect(repoIdentity(tmp())).toBeNull();
  });
});

describe('discoverRepos', () => {
  it('finds direct child repos at depth 1 and does not descend into repos', async () => {
    const root = tmp();
    initRepo(path.join(root, 'a'));
    initRepo(path.join(root, 'b'));
    initRepo(path.join(root, 'a', 'nested'));
    initRepo(path.join(root, 'deep', 'x'));
    const res = await discoverRepos(root, 1);
    expect(res.rootIsRepo).toBe(false);
    expect(res.truncated).toBe(false);
    expect(res.repos.map((r) => r.name)).toEqual(['a', 'b']);
    expect(res.repos[0].path).toBe(path.join(root, 'a'));
  });

  it('finds deeper repos when depth allows', async () => {
    const root = tmp();
    initRepo(path.join(root, 'deep', 'x'));
    const res = await discoverRepos(root, 2);
    expect(res.repos.map((r) => r.name)).toEqual(['deep/x']);
  });

  it('skips hidden dirs, node_modules and symlinked dirs', async () => {
    const root = tmp();
    initRepo(path.join(root, '.hidden'));
    initRepo(path.join(root, 'node_modules'));
    const outside = initRepo(path.join(tmp(), 'outside'));
    fs.symlinkSync(outside, path.join(root, 'link'));
    const res = await discoverRepos(root, 2);
    expect(res.repos).toEqual([]);
  });

  it('looks inside a root that is itself a repo', async () => {
    const root = initRepo(path.join(tmp(), 'root'));
    initRepo(path.join(root, 'sub'));
    const res = await discoverRepos(root, 1);
    expect(res.rootIsRepo).toBe(true);
    expect(res.repos.map((r) => r.name)).toEqual(['sub']);
  });

  it('does not list a linked worktree of a repo already listed', async () => {
    const root = tmp();
    const a = initRepo(path.join(root, 'a'));
    execSync(`git worktree add -q -b wt ${path.join(root, 'wt')}`, { cwd: a, stdio: 'pipe' });
    const res = await discoverRepos(root, 1);
    expect(res.repos.map((r) => r.name)).toEqual(['a']);
  });

  it('caps at 50 repos', async () => {
    const root = tmp();
    for (let i = 0; i < 51; i++) {
      const d = path.join(root, `r${String(i).padStart(2, '0')}`);
      fs.mkdirSync(path.join(d, '.git'), { recursive: true });
      fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    }
    const res = await discoverRepos(root, 1);
    expect(res.repos).toHaveLength(50);
    expect(res.truncated).toBe(true);
  });
});
