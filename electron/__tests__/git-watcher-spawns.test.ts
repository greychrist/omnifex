import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every `git` the watcher runs is a short-lived process, and on macOS each one
// makes syspolicyd log twice — ~3.4M errors a day at 20 spawns per 3 s tick,
// idle. These tests count spawns: watches share one reader per repository,
// polling stops when nobody is looking, and a plain tick never re-lists
// worktrees.

const gitCalls = vi.hoisted(() => [] as string[][]);
const gitFiles = vi.hoisted(() => [] as string[]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: ((file: string, args: string[], ...rest: unknown[]) => {
      if (file === 'git' || file.endsWith('/git')) { gitCalls.push(args); gitFiles.push(file); }
      return (actual.execFile as (...a: unknown[]) => unknown)(file, args, ...rest);
    }) as typeof actual.execFile,
  };
});

import { createSessionGitWatcher } from '../services/git-watcher';

const INTERVAL = 3000;

function makeTempRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-git-spawn-')));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "t@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  execSync('git add README.md && git commit -m init', { cwd: dir, stdio: 'pipe' });
  return dir;
}

const statusCalls = () => gitCalls.filter((a) => a.includes('status')).length;
const listCalls = () => gitCalls.filter((a) => a.includes('worktree')).length;

/** Let the debounce (real 80 ms) and the spawned git processes finish. */
async function settle(): Promise<void> {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (gitCalls.length === last && i > 3) return;
    last = gitCalls.length;
  }
}

describe('git watcher — process churn', () => {
  const dirs: string[] = [];
  let send: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => void>>;

  beforeEach(() => {
    gitCalls.length = 0;
    gitFiles.length = 0;
    send = vi.fn<(channel: string, ...args: unknown[]) => void>();
    // Only the poll interval is faked: ticks fire when the test says so.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  async function tick(n = 1): Promise<void> {
    for (let i = 0; i < n; i++) {
      vi.advanceTimersByTime(INTERVAL);
      await settle();
    }
  }

  it('two sessions on one repository share one reader — one git status per path per tick', async () => {
    const repo = makeTempRepo(); dirs.push(repo);
    const link = path.join(fs.realpathSync(os.tmpdir()), `gc-link-${Date.now()}`);
    fs.symlinkSync(repo, link); dirs.push(link);
    const w = createSessionGitWatcher({ sendToRenderer: send, pollIntervalMs: INTERVAL });
    const a = await w.start(repo);
    const b = await w.start(link); // same repo through a symlink
    await settle();
    gitCalls.length = 0;

    await tick(3);
    expect(statusCalls()).toBe(3);

    // Both still hear about a change.
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x');
    send.mockClear();
    await tick();
    const channels = send.mock.calls.map((c) => c[0]);
    expect(channels).toContain(`session-git-changed:${a.watchId}`);
    expect(channels).toContain(`session-git-changed:${b.watchId}`);
    w.disposeAll();
  });

  it('a session on a worktree shares the reader with a session on the main checkout', async () => {
    const repo = makeTempRepo(); dirs.push(repo);
    const wt = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-wt-'))), 'feature');
    dirs.push(path.dirname(wt));
    execSync(`git worktree add -b feature "${wt}"`, { cwd: repo, stdio: 'pipe' });
    const w = createSessionGitWatcher({ sendToRenderer: send, pollIntervalMs: INTERVAL });
    const main = await w.start(repo);
    const feature = await w.start(wt);
    expect(main.snapshot.worktrees.map((p) => p.path)).toEqual([wt]);
    expect(feature.snapshot.worktrees.map((p) => p.path)).toEqual([repo]);
    await settle();
    gitCalls.length = 0;

    await tick(2);
    // Two paths, two ticks: 4 — not 8 (each session reading both).
    expect(statusCalls()).toBe(4);
    w.disposeAll();
  });

  it('a plain poll tick never re-lists worktrees', async () => {
    const repo = makeTempRepo(); dirs.push(repo);
    const w = createSessionGitWatcher({ sendToRenderer: send, pollIntervalMs: INTERVAL });
    await w.start(repo);
    await settle();
    gitCalls.length = 0;
    await tick(3);
    expect(listCalls()).toBe(0);
    expect(statusCalls()).toBe(3);
    w.disposeAll();
  });

  it('stop() is reference-counted: the reader lives until the last watch stops', async () => {
    const repo = makeTempRepo(); dirs.push(repo);
    const w = createSessionGitWatcher({ sendToRenderer: send, pollIntervalMs: INTERVAL });
    const a = await w.start(repo);
    const b = await w.start(repo);
    await settle();
    w.stop(a.watchId);
    gitCalls.length = 0;
    await tick();
    expect(statusCalls()).toBe(1);
    w.stop(b.watchId);
    gitCalls.length = 0;
    await tick(2);
    expect(gitCalls).toEqual([]);
  });

  it('pauses while no watch is visible, then refreshes once when one becomes visible', async () => {
    const repo = makeTempRepo(); dirs.push(repo);
    const w = createSessionGitWatcher({ sendToRenderer: send, pollIntervalMs: INTERVAL });
    const a = await w.start(repo);
    const b = await w.start(repo);
    await settle();
    w.setVisible(a.watchId, false);
    w.setVisible(b.watchId, false);
    gitCalls.length = 0;

    // Hidden: no polling, and a working-tree edit does not wake it either.
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x');
    execSync('git add dirty.txt', { cwd: repo, stdio: 'pipe' }); // touches .git/index
    await tick(4);
    expect(gitCalls).toEqual([]);

    // Visible again: one immediate refresh, before any tick, with the change.
    send.mockClear();
    w.setVisible(b.watchId, true);
    await settle();
    expect(statusCalls()).toBe(1);
    const last = send.mock.calls.filter((c) => c[0] === `session-git-changed:${b.watchId}`).at(-1)?.[1] as { project: { changed: number } };
    expect(last.project.changed).toBe(1);
    w.disposeAll();
  });

  it('keeps polling while any one watch on the repository is visible', async () => {
    const repo = makeTempRepo(); dirs.push(repo);
    const w = createSessionGitWatcher({ sendToRenderer: send, pollIntervalMs: INTERVAL });
    const a = await w.start(repo);
    await w.start(repo);
    await settle();
    w.setVisible(a.watchId, false);
    gitCalls.length = 0;
    await tick(2);
    expect(statusCalls()).toBe(2);
    w.disposeAll();
  });

  it('a watch joining a reader nobody was looking at reads once, and sees what changed', async () => {
    const repo = makeTempRepo(); dirs.push(repo);
    const w = createSessionGitWatcher({ sendToRenderer: send, pollIntervalMs: INTERVAL });
    const a = await w.start(repo);
    await settle();
    w.setVisible(a.watchId, false);
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x'); // a working-tree edit: no .git write
    gitCalls.length = 0;
    const b = await w.start(repo);
    expect(statusCalls()).toBe(1);
    expect(b.snapshot.project.untracked).toBe(1);
    w.disposeAll();
  });

  it('starting a new reader reads each path once, not twice', async () => {
    const repo = makeTempRepo(); dirs.push(repo);
    const w = createSessionGitWatcher({ sendToRenderer: send, pollIntervalMs: INTERVAL });
    await w.start(repo);
    expect(statusCalls()).toBe(1);
    w.disposeAll();
  });

  it('runs git by absolute path, so libuv does not posix_spawn once per PATH entry', async () => {
    const repo = makeTempRepo(); dirs.push(repo);
    const w = createSessionGitWatcher({ sendToRenderer: send, pollIntervalMs: INTERVAL });
    await w.start(repo);
    await settle();
    expect(gitFiles.length).toBeGreaterThan(0);
    for (const f of gitFiles) expect(path.isAbsolute(f)).toBe(true);
    w.disposeAll();
  });

  describe('a watch held by a client connection', () => {
    function holder() {
      const listeners: (() => void)[] = [];
      return {
        onClose: (fn: () => void) => { listeners.push(fn); },
        close: () => { for (const fn of listeners.splice(0)) fn(); },
      };
    }

    it('stops polling when the connection that holds it closes', async () => {
      const repo = makeTempRepo(); dirs.push(repo);
      const w = createSessionGitWatcher({ sendToRenderer: send, pollIntervalMs: INTERVAL });
      const conn = holder();
      await w.start(repo, conn);
      await settle();
      gitCalls.length = 0;
      await tick();
      expect(statusCalls()).toBe(1);

      conn.close();
      gitCalls.length = 0;
      await tick(3);
      expect(gitCalls).toEqual([]);
      w.disposeAll();
    });

    it('resumes when a reconnected client reports it visible, and the old connection no longer holds it', async () => {
      const repo = makeTempRepo(); dirs.push(repo);
      const w = createSessionGitWatcher({ sendToRenderer: send, pollIntervalMs: INTERVAL });
      const first = holder();
      const a = await w.start(repo, first);
      await settle();
      first.close();

      const second = holder();
      w.setVisible(a.watchId, true, second);
      await settle();
      gitCalls.length = 0;
      await tick();
      expect(statusCalls()).toBe(1);

      // A late close from the first connection must not hide it again.
      first.close();
      gitCalls.length = 0;
      await tick();
      expect(statusCalls()).toBe(1);

      second.close();
      gitCalls.length = 0;
      await tick(2);
      expect(gitCalls).toEqual([]);
      w.disposeAll();
    });

    it('a watch with no holder (the in-process IPC path) is unaffected', async () => {
      const repo = makeTempRepo(); dirs.push(repo);
      const w = createSessionGitWatcher({ sendToRenderer: send, pollIntervalMs: INTERVAL });
      await w.start(repo);
      await settle();
      gitCalls.length = 0;
      await tick(2);
      expect(statusCalls()).toBe(2);
      w.disposeAll();
    });
  });
});
