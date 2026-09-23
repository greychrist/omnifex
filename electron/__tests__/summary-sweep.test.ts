import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSummarySweep } from '../services/summary-sweep';

const MIN = 60_000;
const NOW = Date.parse('2026-09-22T12:00:00Z');
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';

let root: string;
let cfg: string;

function writeSession(opts: {
  uuid: string;
  dir?: string;
  cwd?: string;
  ageMs: number;
  sidecarSize?: number | 'match';
}): string {
  const dir = path.join(cfg, 'projects', opts.dir ?? '-Users-me-repo');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${opts.uuid}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'queue-operation' }),
    JSON.stringify({ type: 'user', cwd: opts.cwd ?? '/Users/me/repo', message: { content: 'hi' } }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const t = (NOW - opts.ageMs) / 1000;
  fs.utimesSync(file, t, t);
  if (opts.sidecarSize !== undefined) {
    const size = opts.sidecarSize === 'match' ? fs.statSync(file).size : opts.sidecarSize;
    fs.writeFileSync(file.replace(/\.jsonl$/, '.summary.json'), JSON.stringify({ version: 1, jsonlSize: size }));
  }
  return file;
}

function harness(opts: { active?: string[]; result?: string; maxPerTick?: number } = {}) {
  const generateSummary = vi.fn(async (_uuid: string, _projectPath: string, _configDir: string) => ({ status: opts.result ?? 'generated' }));
  const sweep = createSummarySweep({
    listConfigDirs: () => [cfg],
    activeSessionIds: () => opts.active ?? [],
    summary: () => ({ generateSummary }),
    now: () => NOW,
    ...(opts.maxPerTick ? { maxPerTick: opts.maxPerTick } : {}),
    log: { info: vi.fn(), warn: vi.fn() },
  });
  return { sweep, generateSummary };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-sweep-'));
  cfg = path.join(root, 'cfg');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('summary sweep', () => {
  it('summarizes an idle session that has no summary, under its recorded cwd and config dir', async () => {
    writeSession({ uuid: U1, ageMs: 30 * MIN, cwd: '/Users/me/my.repo' });
    const h = harness();
    expect(await h.sweep.tick()).toBe(1);
    expect(h.generateSummary).toHaveBeenCalledWith(U1, '/Users/me/my.repo', cfg);
  });

  it('re-summarizes a session that grew since its summary', async () => {
    writeSession({ uuid: U1, ageMs: 30 * MIN, sidecarSize: 3 });
    const h = harness();
    expect(await h.sweep.tick()).toBe(1);
  });

  it('leaves a session whose summary matches its transcript', async () => {
    writeSession({ uuid: U1, ageMs: 30 * MIN, sidecarSize: 'match' });
    const h = harness();
    expect(await h.sweep.tick()).toBe(0);
    expect(h.generateSummary).not.toHaveBeenCalled();
  });

  it('skips sessions still being written, open in a tab, or older than the lookback', async () => {
    writeSession({ uuid: U1, ageMs: 2 * MIN });
    writeSession({ uuid: U2, ageMs: 30 * MIN });
    writeSession({ uuid: U3, ageMs: 30 * 24 * 60 * MIN });
    const h = harness({ active: [U2] });
    expect(await h.sweep.tick()).toBe(0);
  });

  it("never summarizes OmniFex's own summary scratch transcripts", async () => {
    writeSession({ uuid: U1, ageMs: 30 * MIN, dir: '-private-var-folders-x-T-omnifex-summary-scratch' });
    const h = harness();
    expect(await h.sweep.tick()).toBe(0);
  });

  it('caps the work per tick, newest first', async () => {
    writeSession({ uuid: U1, ageMs: 90 * MIN });
    writeSession({ uuid: U2, ageMs: 30 * MIN });
    writeSession({ uuid: U3, ageMs: 60 * MIN });
    const h = harness({ maxPerTick: 2 });
    expect(await h.sweep.tick()).toBe(2);
    expect(h.generateSummary.mock.calls.map((c) => c[0])).toEqual([U2, U3]);
  });

  it('does not retry the same transcript size after a failed or skipped attempt', async () => {
    writeSession({ uuid: U1, ageMs: 30 * MIN });
    const h = harness({ result: 'malformed-response' });
    expect(await h.sweep.tick()).toBe(1);
    expect(await h.sweep.tick()).toBe(0);
    expect(h.generateSummary).toHaveBeenCalledTimes(1);
  });

  it('keeps going when one generation throws', async () => {
    writeSession({ uuid: U1, ageMs: 30 * MIN });
    writeSession({ uuid: U2, ageMs: 60 * MIN });
    const h = harness();
    h.generateSummary.mockRejectedValueOnce(new Error('rate limited'));
    expect(await h.sweep.tick()).toBe(2);
  });

  it('does nothing without a summary service or config dirs', async () => {
    writeSession({ uuid: U1, ageMs: 30 * MIN });
    const sweep = createSummarySweep({
      listConfigDirs: () => [path.join(root, 'missing')],
      activeSessionIds: () => [],
      summary: () => null,
      now: () => NOW,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(await sweep.tick()).toBe(0);
  });
});
