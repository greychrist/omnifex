import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGitWatcherService } from '../services/git-watcher';

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

    const { watchId, branch } = await service.start(repo);

    expect(typeof watchId).toBe('string');
    expect(watchId.length).toBeGreaterThan(0);
    expect(branch).toBe('main');
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

    expect(call[1]).toEqual({ branch: 'feature' });
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
