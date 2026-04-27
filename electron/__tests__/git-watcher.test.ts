import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGitWatcherService, listWorktrees } from '../services/git-watcher';

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-git-watch-'));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  execSync('git add README.md', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: dir, stdio: 'pipe' });
  return dir;
}

async function waitFor<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v !== undefined && v !== null) return v as T;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timed out');
}

describe('git-watcher service', () => {
  let tempDirs: string[] = [];
  let service: ReturnType<typeof createGitWatcherService>;
  let sendToRenderer: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => void>>;

  beforeEach(() => {
    tempDirs = [];
    sendToRenderer = vi.fn<(channel: string, ...args: unknown[]) => void>();
    service = createGitWatcherService({ sendToRenderer });
  });

  afterEach(() => {
    service.disposeAll();
    for (const d of tempDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it('returns the current branch on start for a real repo', async () => {
    const repo = makeTempRepo();
    tempDirs.push(repo);

    const { watchId, branch, changed, untracked } = await service.start(repo);

    expect(typeof watchId).toBe('string');
    expect(watchId.length).toBeGreaterThan(0);
    expect(branch).toBe('main');
    expect(changed).toBe(0);
    expect(untracked).toBe(0);
  });

  it('returns counts of changed and untracked files on start for a dirty repo', async () => {
    const repo = makeTempRepo();
    tempDirs.push(repo);

    // Modify the tracked file (1 changed)
    fs.writeFileSync(path.join(repo, 'README.md'), 'modified\n');
    // Add two untracked files
    fs.writeFileSync(path.join(repo, 'new1.txt'), 'a\n');
    fs.writeFileSync(path.join(repo, 'new2.txt'), 'b\n');

    const { changed, untracked } = await service.start(repo);

    expect(changed).toBe(1);
    expect(untracked).toBe(2);
  });

  it('emits updated counts when the working tree changes', async () => {
    const repo = makeTempRepo();
    tempDirs.push(repo);

    service = createGitWatcherService({ sendToRenderer, pollIntervalMs: 100 });
    const { watchId } = await service.start(repo);

    // Touch the working tree so a poll picks it up
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'hi\n');

    const call = await waitFor(() =>
      sendToRenderer.mock.calls.find(
        ([channel, payload]) =>
          channel === `git-branch-changed:${watchId}` &&
          (payload as { untracked: number }).untracked === 1,
      ),
    );

    expect(call[1]).toMatchObject({ branch: 'main', changed: 0, untracked: 1 });
  });

  it('returns zero counts for a non-git directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-not-repo-counts-'));
    tempDirs.push(dir);

    const { changed, untracked } = await service.start(dir);
    expect(changed).toBe(0);
    expect(untracked).toBe(0);
  });

  it('returns branch null for a non-git directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-not-repo-'));
    tempDirs.push(dir);

    const { branch } = await service.start(dir);
    expect(branch).toBeNull();
  });

  it('emits the new branch after a checkout', async () => {
    const repo = makeTempRepo();
    tempDirs.push(repo);

    const { watchId } = await service.start(repo);

    execSync('git checkout -b feature', { cwd: repo, stdio: 'pipe' });

    const call = await waitFor(() =>
      sendToRenderer.mock.calls.find(
        ([channel]) => channel === `git-branch-changed:${watchId}`,
      ),
    );

    expect(call[1]).toMatchObject({ branch: 'feature' });
  });

  it('stops emitting after stop()', async () => {
    const repo = makeTempRepo();
    tempDirs.push(repo);

    const { watchId } = await service.start(repo);
    service.stop(watchId);

    execSync('git checkout -b feature', { cwd: repo, stdio: 'pipe' });

    // give fs.watch a chance to fire
    await new Promise((r) => setTimeout(r, 200));

    const hits = sendToRenderer.mock.calls.filter(
      ([channel]) => channel === `git-branch-changed:${watchId}`,
    );
    expect(hits.length).toBe(0);
  });

  describe('listWorktrees', () => {
    it('returns an empty array for a non-git directory', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-not-repo-wt-'));
      tempDirs.push(dir);

      const result = await listWorktrees(dir);
      expect(result).toEqual([]);
    });

    it('returns an empty array when the repo has no extra worktrees', async () => {
      const repo = makeTempRepo();
      tempDirs.push(repo);

      const result = await listWorktrees(repo);
      expect(result).toEqual([]);
    });

    it('returns peer worktrees with branch names, excluding the queried path', async () => {
      const repo = makeTempRepo();
      tempDirs.push(repo);

      const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-wt-root-'));
      tempDirs.push(wtRoot);
      const wt1 = path.join(wtRoot, 'feature-a');
      const wt2 = path.join(wtRoot, 'feature-b');

      execSync(`git worktree add -b feature-a "${wt1}"`, { cwd: repo, stdio: 'pipe' });
      execSync(`git worktree add -b feature-b "${wt2}"`, { cwd: repo, stdio: 'pipe' });

      const fromMain = await listWorktrees(repo);
      expect(fromMain).toHaveLength(2);
      expect(fromMain.map((w) => w.branch).sort()).toEqual(['feature-a', 'feature-b']);
      // Paths should be the worktree paths, not the main repo
      expect(fromMain.every((w) => w.path !== repo)).toBe(true);

      // Querying from a worktree should exclude that worktree but include the
      // main repo + the sibling worktree.
      const fromWt1 = await listWorktrees(wt1);
      expect(fromWt1).toHaveLength(2);
      expect(fromWt1.every((w) => w.path !== wt1)).toBe(true);
      const branches = fromWt1.map((w) => w.branch).sort();
      expect(branches).toEqual(['feature-b', 'main']);
    });

    it('reports null branch for detached worktrees', async () => {
      const repo = makeTempRepo();
      tempDirs.push(repo);

      const headSha = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim();
      const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-wt-detached-'));
      tempDirs.push(wtRoot);
      const wt = path.join(wtRoot, 'detached');
      execSync(`git worktree add --detach "${wt}" ${headSha}`, { cwd: repo, stdio: 'pipe' });

      const result = await listWorktrees(repo);
      expect(result).toHaveLength(1);
      expect(result[0].branch).toBeNull();
      expect(result[0].path).toBe(fs.realpathSync(wt));
    });
  });

  it('resolves gitdir from a .git file (worktree-style)', async () => {
    const primary = makeTempRepo();
    tempDirs.push(primary);

    // Build a fake worktree: a second directory whose .git is a file that
    // points at an external gitdir. We reuse the primary repo's .git
    // directory so HEAD reflects its state, which is sufficient for this test.
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-worktree-'));
    tempDirs.push(worktree);
    fs.writeFileSync(
      path.join(worktree, '.git'),
      `gitdir: ${path.join(primary, '.git')}\n`,
    );

    const { branch } = await service.start(worktree);
    expect(branch).toBe('main');
  });
});
