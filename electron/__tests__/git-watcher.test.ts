import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionGitWatcher, listWorktrees } from '../services/git-watcher';

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
  let sendToRenderer: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => void>>;

  beforeEach(() => {
    tempDirs = [];
    sendToRenderer = vi.fn<(channel: string, ...args: unknown[]) => void>();
  });

  afterEach(() => {
    for (const d of tempDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
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
  describe('createSessionGitWatcher', () => {
    function makeService(opts?: { pollIntervalMs?: number }) {
      return createSessionGitWatcher({
        sendToRenderer,
        pollIntervalMs: opts?.pollIntervalMs ?? 5000,
        readTimeoutMs: 4000,
      });
    }

    it('start() returns a unified initial snapshot for project + peers', async () => {
      const repo = makeTempRepo();
      tempDirs.push(repo);

      const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-sgw-init-'));
      tempDirs.push(wtRoot);
      const wt = path.join(wtRoot, 'feat-a');
      execSync(`git worktree add -b feat-a "${wt}"`, { cwd: repo, stdio: 'pipe' });

      const svc = makeService();
      const { watchId, snapshot } = await svc.start(repo);
      try {
        expect(watchId).toMatch(/^[0-9a-f-]{36}$/);
        expect(snapshot.project.branch).toBe('main');
        expect(snapshot.project.error).toBeNull();
        expect(snapshot.worktrees).toHaveLength(1);
        expect(snapshot.worktrees[0].branch).toBe('feat-a');
        expect(snapshot.worktrees[0].error).toBeNull();
      } finally {
        svc.stop(watchId);
      }
    });

    it('emits when a new peer worktree is added', async () => {
      const repo = makeTempRepo();
      tempDirs.push(repo);

      const svc = makeService({ pollIntervalMs: 200 });
      const { watchId } = await svc.start(repo);
      try {
        const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-sgw-add-'));
        tempDirs.push(wtRoot);
        const wt = path.join(wtRoot, 'feat-new');
        execSync(`git worktree add -b feat-new "${wt}"`, { cwd: repo, stdio: 'pipe' });

        const call = await waitFor(() =>
          sendToRenderer.mock.calls.find(
            ([channel, payload]) =>
              channel === `session-git-changed:${watchId}` &&
              (payload as { worktrees: Array<{ branch: string }> }).worktrees.some(
                (w) => w.branch === 'feat-new',
              ),
          ),
        );
        expect(call).toBeDefined();
      } finally {
        svc.stop(watchId);
      }
    });

    it('emits when a peer worktree is removed', async () => {
      const repo = makeTempRepo();
      tempDirs.push(repo);

      const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-sgw-rm-'));
      tempDirs.push(wtRoot);
      const wt = path.join(wtRoot, 'feat-doomed');
      execSync(`git worktree add -b feat-doomed "${wt}"`, { cwd: repo, stdio: 'pipe' });

      const svc = makeService({ pollIntervalMs: 200 });
      const { watchId, snapshot } = await svc.start(repo);
      try {
        expect(snapshot.worktrees).toHaveLength(1);

        sendToRenderer.mockClear();
        execSync(`git worktree remove "${wt}"`, { cwd: repo, stdio: 'pipe' });

        const call = await waitFor(() =>
          sendToRenderer.mock.calls.find(
            ([channel, payload]) =>
              channel === `session-git-changed:${watchId}` &&
              (payload as { worktrees: unknown[] }).worktrees.length === 0,
          ),
        );
        expect(call).toBeDefined();
      } finally {
        svc.stop(watchId);
      }
    });

    it('emits updated counts when a peer worktree gets dirty', async () => {
      const repo = makeTempRepo();
      tempDirs.push(repo);

      const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-sgw-dirty-'));
      tempDirs.push(wtRoot);
      const wt = path.join(wtRoot, 'feat-dirty');
      execSync(`git worktree add -b feat-dirty "${wt}"`, { cwd: repo, stdio: 'pipe' });

      const svc = makeService({ pollIntervalMs: 150 });
      const { watchId } = await svc.start(repo);
      try {
        // Seed a brand-new untracked file inside the peer worktree.
        fs.writeFileSync(path.join(wt, 'new.txt'), 'hi\n');

        const call = await waitFor(() =>
          sendToRenderer.mock.calls.find(([channel, payload]) => {
            if (channel !== `session-git-changed:${watchId}`) return false;
            const peer = (payload as { worktrees: Array<{ branch: string; untracked: number }> }).worktrees.find(
              (w) => w.branch === 'feat-dirty',
            );
            return !!peer && peer.untracked === 1;
          }),
        );
        expect(call).toBeDefined();
      } finally {
        svc.stop(watchId);
      }
    });

    it('isolates per-peer errors in the snapshot', async () => {
      const repo = makeTempRepo();
      tempDirs.push(repo);

      const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-sgw-iso-'));
      tempDirs.push(wtRoot);
      const wt = path.join(wtRoot, 'feat-broken');
      execSync(`git worktree add -b feat-broken "${wt}"`, { cwd: repo, stdio: 'pipe' });

      // Corrupt the peer's gitdir pointer so its `git status` fails.
      fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /nonexistent/path/that/does/not/exist\n');

      const svc = makeService({ pollIntervalMs: 5000 });
      const { watchId, snapshot } = await svc.start(repo);
      try {
        expect(snapshot.project.error).toBeNull();
        expect(snapshot.worktrees).toHaveLength(1);
        expect(snapshot.worktrees[0].error).toEqual(expect.any(String));
      } finally {
        svc.stop(watchId);
      }
    });

    it('reconnect() returns null for an unknown watchId', async () => {
      const svc = makeService();
      const result = await svc.reconnect('nope');
      expect(result).toBeNull();
    });

    it('reconnect() re-runs and clears stale state', async () => {
      const repo = makeTempRepo();
      tempDirs.push(repo);

      const svc = makeService({ pollIntervalMs: 5000 });
      const { watchId } = await svc.start(repo);
      try {
        const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-sgw-rc-'));
        tempDirs.push(wtRoot);
        const wt = path.join(wtRoot, 'feat-late');
        execSync(`git worktree add -b feat-late "${wt}"`, { cwd: repo, stdio: 'pipe' });

        // Skip the fs.watch path entirely — call reconnect to force a
        // fresh enumeration.
        const fresh = await svc.reconnect(watchId);
        expect(fresh).not.toBeNull();
        expect(fresh!.worktrees.some((w) => w.branch === 'feat-late')).toBe(true);
      } finally {
        svc.stop(watchId);
      }
    });

    it('stop() closes all watchers and stops emitting', async () => {
      const repo = makeTempRepo();
      tempDirs.push(repo);

      const svc = makeService({ pollIntervalMs: 100 });
      const { watchId } = await svc.start(repo);
      svc.stop(watchId);

      sendToRenderer.mockClear();
      execSync('git checkout -b post-stop', { cwd: repo, stdio: 'pipe' });
      await new Promise((r) => setTimeout(r, 250));

      const hits = sendToRenderer.mock.calls.filter(
        ([channel]) => channel === `session-git-changed:${watchId}`,
      );
      expect(hits.length).toBe(0);
    });
  });

});
