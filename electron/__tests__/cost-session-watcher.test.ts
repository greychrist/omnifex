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
  const fakeFs: CostFs = {
    readFile: (p) => files[p] ?? null,
    listDir: (p) => dirs[p] ?? [],
  };
  const stat = (p: string) => (p in files ? { mtimeMs: files[p].length, size: files[p].length } : null);
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
});
