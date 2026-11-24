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
    if (v !== undefined && v !== null) return v;
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
      expect(fromMain.every((w) => w.path !== repo)).toBe(true);

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
        expect(snapshot.repos[0].root.branch).toBe('main');
        expect(snapshot.repos[0].root.error).toBeNull();
        expect(snapshot.repos[0].worktrees).toHaveLength(1);
        expect(snapshot.repos[0].worktrees[0].branch).toBe('feat-a');
        expect(snapshot.repos[0].worktrees[0].error).toBeNull();
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
              (payload as { repos: { worktrees: { branch: string }[] }[] }).repos[0].worktrees.some(
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
        expect(snapshot.repos[0].worktrees).toHaveLength(1);

        sendToRenderer.mockClear();
        execSync(`git worktree remove "${wt}"`, { cwd: repo, stdio: 'pipe' });

        const call = await waitFor(() =>
          sendToRenderer.mock.calls.find(
            ([channel, payload]) =>
              channel === `session-git-changed:${watchId}` &&
              (payload as { repos: { worktrees: unknown[] }[] }).repos[0].worktrees.length === 0,
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
        fs.writeFileSync(path.join(wt, 'new.txt'), 'hi\n');

        const call = await waitFor(() =>
          sendToRenderer.mock.calls.find(([channel, payload]) => {
            if (channel !== `session-git-changed:${watchId}`) return false;
            const peer = (payload as { repos: { worktrees: { branch: string; untracked: number }[] }[] }).repos[0].worktrees.find(
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

      fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /nonexistent/path/that/does/not/exist\n');

      const svc = makeService({ pollIntervalMs: 5000 });
      const { watchId, snapshot } = await svc.start(repo);
      try {
        expect(snapshot.repos[0].root.error).toBeNull();
        expect(snapshot.repos[0].worktrees).toHaveLength(1);
        expect(snapshot.repos[0].worktrees[0].error).toEqual(expect.any(String));
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

        const fresh = await svc.reconnect(watchId);
        expect(fresh).not.toBeNull();
        expect(fresh!.repos[0].worktrees.some((w) => w.branch === 'feat-late')).toBe(true);
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

    describe('a project of several repos', () => {
      function makeParent(): { root: string; a: string; b: string } {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-sgw-multi-')));
        tempDirs.push(root);
        const a = makeTempRepo();
        const b = makeTempRepo();
        tempDirs.push(a, b);
        fs.renameSync(a, path.join(root, 'a'));
        fs.renameSync(b, path.join(root, 'b'));
        return { root, a: path.join(root, 'a'), b: path.join(root, 'b') };
      }

      function makeMulti(watched: () => { path: string; name: string }[], found = async () => 0) {
        return createSessionGitWatcher({
          sendToRenderer,
          pollIntervalMs: 5000,
          readTimeoutMs: 4000,
          repos: { watchedRepos: watched, foundCount: found },
        });
      }

      it('a non-repo project with nothing watched reports only what was found', async () => {
        const { root } = makeParent();
        const svc = makeMulti(() => [], async () => 2);
        const { watchId, snapshot } = await svc.start(root);
        expect(snapshot).toEqual({ repos: [], foundCount: 2 });
        svc.stop(watchId);
      });

      it('reports each watched repo by name with its own counts', async () => {
        const { root, a, b } = makeParent();
        fs.writeFileSync(path.join(b, 'new.txt'), 'x');
        const svc = makeMulti(() => [{ path: a, name: 'a' }, { path: b, name: 'b' }]);
        const { watchId, snapshot } = await svc.start(root);
        try {
          expect(snapshot.repos.map((r) => r.name)).toEqual(['a', 'b']);
          expect(snapshot.repos[0].root).toMatchObject({ path: a, branch: 'main', untracked: 0 });
          expect(snapshot.repos[1].root).toMatchObject({ path: b, branch: 'main', untracked: 1 });
        } finally {
          svc.stop(watchId);
        }
      });

      it('reconfigure() adds and drops repos on live watches of that project', async () => {
        const { root, a, b } = makeParent();
        let watched = [{ path: a, name: 'a' }];
        const svc = makeMulti(() => watched);
        const { watchId } = await svc.start(root);
        try {
          watched = [{ path: a, name: 'a' }, { path: b, name: 'b' }];
          sendToRenderer.mockClear();
          await svc.reconfigure(root);
          const added = sendToRenderer.mock.calls.filter(([c]) => c === `session-git-changed:${watchId}`).at(-1)?.[1] as { repos: { name: string }[] };
          expect(added.repos.map((r) => r.name)).toEqual(['a', 'b']);

          watched = [{ path: b, name: 'b' }];
          await svc.reconfigure(root);
          const dropped = sendToRenderer.mock.calls.filter(([c]) => c === `session-git-changed:${watchId}`).at(-1)?.[1] as { repos: { name: string }[] };
          expect(dropped.repos.map((r) => r.name)).toEqual(['b']);
        } finally {
          svc.stop(watchId);
        }
      });

      it('reconfigure() leaves watches of other projects alone', async () => {
        const { root, a } = makeParent();
        const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-sgw-other-')));
        tempDirs.push(other);
        const svc = makeMulti(() => [{ path: a, name: 'a' }]);
        const mine = await svc.start(root);
        const theirs = await svc.start(other);
        sendToRenderer.mockClear();
        await svc.reconfigure(root);
        expect(sendToRenderer.mock.calls.some(([c]) => c === `session-git-changed:${theirs.watchId}`)).toBe(false);
        svc.stop(mine.watchId);
        svc.stop(theirs.watchId);
      });
    });
  });

});
