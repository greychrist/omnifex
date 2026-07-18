import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { createSessionCostService } from '../services/cost/session-cost';
import type { CostFs } from '../services/cost/cost-history';
import type { SessionCostDailyRow } from '../services/cost/session-cost-core';

const CFG = '/cfg';
const PROJECT = '/Users/me/proj';
const PROJECT_DIR = path.join(CFG, 'projects', '-Users-me-proj');
const SESSION_FILE = path.join(PROJECT_DIR, 'sess1.jsonl');
const SUBAGENTS_DIR = path.join(PROJECT_DIR, 'sess1', 'subagents');

const args = { configDir: CFG, projectPath: PROJECT, sessionId: 'sess1', accountName: 'Work' };

function assistantLine(req: string, out: number): string {
  return JSON.stringify({
    type: 'assistant', requestId: req, timestamp: '2026-07-17T01:00:00Z',
    message: { id: `m_${req}`, model: 'claude-opus-4-8', usage: { output_tokens: out } },
  });
}

function makeWorld(initial: string) {
  const files: Record<string, string> = { [SESSION_FILE]: initial };
  const dirs: Record<string, Array<{ name: string; isDirectory: boolean }>> = { [SUBAGENTS_DIR]: [] };
  const stat = (p: string) => (p in files ? { mtimeMs: files[p].length, size: files[p].length } : null);
  const fakeFs: CostFs = {
    readFile: (p) => files[p] ?? null,
    listDir: (p) => dirs[p] ?? [],
    stat,
  };
  return { files, dirs, fakeFs, stat };
}

describe('session-cost watcher', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('get() computes a snapshot and upserts history', () => {
    const world = makeWorld(assistantLine('r1', 1000));
    const upserts: Array<{ sessionId: string; rows: SessionCostDailyRow[] }> = [];
    const svc = createSessionCostService({
      sendToRenderer: () => {},
      costHistory: { replaceSession: (sessionId: string, rows: SessionCostDailyRow[]) => upserts.push({ sessionId, rows }) } as never,
      getOverrides: () => undefined,
      fs: world.fakeFs,
      stat: world.stat,
    });
    const snap = svc.get(args);
    expect(snap.totalUsd).toBeCloseTo(1000 * (25 / 1_000_000), 10);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].sessionId).toBe('sess1');
  });

  it('watch() emits on change and stops after unwatch', () => {
    vi.useFakeTimers();
    const world = makeWorld(assistantLine('r1', 1000));
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const svc = createSessionCostService({
      sendToRenderer: (channel, payload) => emitted.push({ channel, payload }),
      costHistory: null,
      getOverrides: () => undefined,
      fs: world.fakeFs,
      stat: world.stat,
      pollMs: 1000,
    });
    svc.watch(args);
    vi.advanceTimersByTime(1100);
    expect(emitted).toHaveLength(0); // no change yet

    world.files[SESSION_FILE] += '\n' + assistantLine('r2', 2000);
    vi.advanceTimersByTime(1100);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].channel).toBe('session-cost:sess1');
    const payload = emitted[0].payload as { totalUsd: number };
    expect(payload.totalUsd).toBeCloseTo(3000 * (25 / 1_000_000), 10);

    svc.unwatch('sess1');
    world.files[SESSION_FILE] += '\n' + assistantLine('r3', 1);
    vi.advanceTimersByTime(2200);
    expect(emitted).toHaveLength(1);
  });

  it('missing session file yields a zero snapshot without throwing', () => {
    const world = makeWorld('');
    delete world.files[SESSION_FILE];
    const svc = createSessionCostService({
      sendToRenderer: () => {},
      costHistory: null,
      getOverrides: () => undefined,
      fs: world.fakeFs,
      stat: world.stat,
    });
    expect(svc.get(args).totalUsd).toBe(0);
  });

  it('stopAll() clears every active watcher', () => {
    vi.useFakeTimers();
    const world = makeWorld(assistantLine('r1', 1000));
    const args2 = { ...args, sessionId: 'sess2' };
    const SESSION_FILE_2 = path.join(PROJECT_DIR, 'sess2.jsonl');
    world.files[SESSION_FILE_2] = assistantLine('r1', 500);
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const svc = createSessionCostService({
      sendToRenderer: (channel, payload) => emitted.push({ channel, payload }),
      costHistory: null,
      getOverrides: () => undefined,
      fs: world.fakeFs,
      stat: world.stat,
      pollMs: 1000,
    });
    svc.watch(args);
    svc.watch(args2);
    svc.stopAll();

    world.files[SESSION_FILE] += '\n' + assistantLine('r2', 2000);
    world.files[SESSION_FILE_2] += '\n' + assistantLine('r2', 2000);
    vi.advanceTimersByTime(5000);
    expect(emitted).toHaveLength(0);
  });

  it('get() logs a warning and still returns a snapshot when costHistory.replaceSession throws', () => {
    const world = makeWorld(assistantLine('r1', 1000));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svc = createSessionCostService({
      sendToRenderer: () => {},
      costHistory: {
        replaceSession: () => {
          throw new Error('boom');
        },
      } as never,
      getOverrides: () => undefined,
      fs: world.fakeFs,
      stat: world.stat,
    });

    let snap: { totalUsd: number } | undefined;
    expect(() => {
      snap = svc.get(args);
    }).not.toThrow();
    expect(snap!.totalUsd).toBeCloseTo(1000 * (25 / 1_000_000), 10);
    expect(warnSpy).toHaveBeenCalledWith('[session-cost] history upsert failed:', expect.any(Error));

    warnSpy.mockRestore();
  });

  it('includes subagent transcript costs and emits when a subagent file changes', () => {
    vi.useFakeTimers();
    const world = makeWorld(assistantLine('r1', 1000));
    const AGENT_FILE = path.join(SUBAGENTS_DIR, 'agent-x.jsonl');
    world.files[AGENT_FILE] = assistantLine('a1', 500);
    world.dirs[SUBAGENTS_DIR] = [{ name: 'agent-x.jsonl', isDirectory: false }];
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const svc = createSessionCostService({
      sendToRenderer: (channel, payload) => emitted.push({ channel, payload }),
      costHistory: null,
      getOverrides: () => undefined,
      fs: world.fakeFs,
      stat: world.stat,
      pollMs: 1000,
    });

    const snap = svc.get(args);
    expect(snap.totalUsd).toBeCloseTo(1500 * (25 / 1_000_000), 10);

    svc.watch(args);
    vi.advanceTimersByTime(1100);
    expect(emitted).toHaveLength(0);

    world.files[AGENT_FILE] += '\n' + assistantLine('a2', 1000);
    vi.advanceTimersByTime(1100);
    expect(emitted).toHaveLength(1);
    const payload = emitted[0].payload as { totalUsd: number };
    expect(payload.totalUsd).toBeCloseTo(2500 * (25 / 1_000_000), 10);
  });

  it('a non-agent .jsonl appearing in the subagents dir must not trigger an emission', () => {
    vi.useFakeTimers();
    const world = makeWorld(assistantLine('r1', 1000));
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const svc = createSessionCostService({
      sendToRenderer: (channel, payload) => emitted.push({ channel, payload }),
      costHistory: null,
      getOverrides: () => undefined,
      fs: world.fakeFs,
      stat: world.stat,
      pollMs: 1000,
    });
    svc.watch(args);
    vi.advanceTimersByTime(1100);
    expect(emitted).toHaveLength(0);

    // A non-agent-* file lands in the subagents dir (e.g. a stray/renamed
    // file) — compute() ignores it, so signature() must too, or the watcher
    // spuriously emits an unchanged snapshot.
    const STRAY_FILE = path.join(SUBAGENTS_DIR, 'notes.jsonl');
    world.files[STRAY_FILE] = assistantLine('stray', 9999);
    world.dirs[SUBAGENTS_DIR] = [{ name: 'notes.jsonl', isDirectory: false }];
    vi.advanceTimersByTime(1100);
    expect(emitted).toHaveLength(0);
  });

  it('captures the baseline signature before compute() so a write racing the initial read is still detected', () => {
    vi.useFakeTimers();
    const world = makeWorld(assistantLine('r1', 1000));
    // Simulate a concurrent write landing exactly between signature capture
    // and the initial compute()'s readFile: the very first readFile call
    // appends new content to the file it just "read" (as if a real writer
    // hit the disk mid-read). If watch() captured signature() AFTER
    // compute(), that baseline would already reflect the concurrent write
    // and the change would never be seen as a diff.
    let readCount = 0;
    const racingFs: CostFs = {
      readFile: (p) => {
        const content = world.fakeFs.readFile(p);
        readCount += 1;
        if (readCount === 1 && p === SESSION_FILE) {
          world.files[SESSION_FILE] += '\n' + assistantLine('r2', 2000);
        }
        return content;
      },
      listDir: (p) => world.fakeFs.listDir(p),
      stat: (p) => world.fakeFs.stat(p),
    };
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const svc = createSessionCostService({
      sendToRenderer: (channel, payload) => emitted.push({ channel, payload }),
      costHistory: null,
      getOverrides: () => undefined,
      fs: racingFs,
      stat: world.stat,
      pollMs: 1000,
    });
    svc.watch(args);
    vi.advanceTimersByTime(1100);
    expect(emitted).toHaveLength(1);
    const payload = emitted[0].payload as { totalUsd: number };
    expect(payload.totalUsd).toBeCloseTo(3000 * (25 / 1_000_000), 10);
  });

  it("unwatch() on a session that was never watched is a no-op", () => {
    const world = makeWorld(assistantLine('r1', 1000));
    const svc = createSessionCostService({
      sendToRenderer: () => {},
      costHistory: null,
      getOverrides: () => undefined,
      fs: world.fakeFs,
      stat: world.stat,
    });
    expect(() => svc.unwatch('never-watched')).not.toThrow();
  });

  describe('sessions run in a CLI worktree (different encoded projects/ dir)', () => {
    const PROJECTS_DIR = path.join(CFG, 'projects');
    const ALT_DIR_NAME = '-Users-me-proj--claude-worktrees-FIX-1';
    const ALT_DIR = path.join(PROJECTS_DIR, ALT_DIR_NAME);
    const ALT_SESSION_FILE = path.join(ALT_DIR, 'sess1.jsonl');

    function makeWorktreeWorld() {
      const world = makeWorld('');
      delete world.files[SESSION_FILE]; // primary encoded dir never got this transcript
      world.files[ALT_SESSION_FILE] = assistantLine('r1', 1000);
      world.dirs[PROJECTS_DIR] = [
        { name: '-Users-me-proj', isDirectory: true },
        { name: ALT_DIR_NAME, isDirectory: true },
      ];
      return world;
    }

    it('get() finds the transcript under the sibling encoded dir and returns the real cost, not zero', () => {
      const world = makeWorktreeWorld();
      const svc = createSessionCostService({
        sendToRenderer: () => {},
        costHistory: null,
        getOverrides: () => undefined,
        fs: world.fakeFs,
        stat: world.stat,
      });
      const snap = svc.get(args);
      expect(snap.totalUsd).toBeCloseTo(1000 * (25 / 1_000_000), 10);
    });

    it('watch() resolves the same alternate dir for signature() and compute(), and emits on a change to the alt file', () => {
      vi.useFakeTimers();
      const world = makeWorktreeWorld();
      const emitted: Array<{ channel: string; payload: unknown }> = [];
      const svc = createSessionCostService({
        sendToRenderer: (channel, payload) => emitted.push({ channel, payload }),
        costHistory: null,
        getOverrides: () => undefined,
        fs: world.fakeFs,
        stat: world.stat,
        pollMs: 1000,
      });
      const initial = svc.watch(args);
      expect(initial.totalUsd).toBeCloseTo(1000 * (25 / 1_000_000), 10);

      vi.advanceTimersByTime(1100);
      expect(emitted).toHaveLength(0); // no change yet

      world.files[ALT_SESSION_FILE] += '\n' + assistantLine('r2', 2000);
      vi.advanceTimersByTime(1100);
      expect(emitted).toHaveLength(1);
      const payload = emitted[0].payload as { totalUsd: number };
      expect(payload.totalUsd).toBeCloseTo(3000 * (25 / 1_000_000), 10);
    });

    it('caches the resolved alt dir so later polls do not rescan projects/ for the same session', () => {
      vi.useFakeTimers();
      const world = makeWorktreeWorld();
      let projectsDirScans = 0;
      const countingFs: CostFs = {
        readFile: (p) => world.fakeFs.readFile(p),
        listDir: (p) => {
          if (p === PROJECTS_DIR) projectsDirScans += 1;
          return world.fakeFs.listDir(p);
        },
        stat: (p) => world.fakeFs.stat(p),
      };
      const emitted: Array<{ channel: string; payload: unknown }> = [];
      const svc = createSessionCostService({
        sendToRenderer: (channel, payload) => emitted.push({ channel, payload }),
        costHistory: null,
        getOverrides: () => undefined,
        fs: countingFs,
        stat: world.stat,
        pollMs: 1000,
      });

      svc.watch(args);
      expect(projectsDirScans).toBe(1);

      world.files[ALT_SESSION_FILE] += '\n' + assistantLine('r2', 2000);
      vi.advanceTimersByTime(1100);
      expect(emitted).toHaveLength(1);
      expect(projectsDirScans).toBe(1); // still cached, no rescan on the poll tick
    });
  });
});
