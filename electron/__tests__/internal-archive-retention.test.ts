import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  pruneInternalArchive,
  internalArchiveStats,
  clearInternalArchive,
} from '../services/sessions/internal-archive';
import { createDatabase, type Database } from '../services/database';
import { createCostHistoryService, nodeCostFs } from '../services/cost/cost-history';

/**
 * Retention exists so the archive cannot grow without bound. The property that
 * makes it safe is that pruning a transcript does NOT remove the money it
 * already accounted for: `replaceSession` deletes only the session it is
 * replacing, and `backfill` only visits transcripts it finds. Without that,
 * a finite archive would silently shrink history every time it pruned.
 */
describe('internal archive retention', () => {
  let root: string;

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-arch-ret-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  function seed(account: string, kind: string, date: string, name = 'a.jsonl', body = 'x'): string {
    const dir = path.join(root, account, kind, date);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, body, 'utf-8');
    return p;
  }

  it('drops date directories older than the cap and keeps the rest', () => {
    const old = seed('Work', 'brain-index', '2026-05-01');
    const recent = seed('Work', 'brain-index', '2026-08-20');
    const r = pruneInternalArchive(root, 90, '2026-08-26');
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(r.removedDays).toBe(1);
  });

  it('keeps everything when the cap is zero', () => {
    const old = seed('Work', 'brain-index', '2020-01-01');
    expect(pruneInternalArchive(root, 0, '2026-08-26').removedDays).toBe(0);
    expect(fs.existsSync(old)).toBe(true);
  });

  it('ignores a directory that is not a date', () => {
    seed('Work', 'brain-index', 'not-a-date');
    expect(() => pruneInternalArchive(root, 90, '2026-08-26')).not.toThrow();
    expect(fs.existsSync(path.join(root, 'Work', 'brain-index', 'not-a-date'))).toBe(true);
  });

  it('is a no-op on an archive that does not exist yet', () => {
    expect(pruneInternalArchive(path.join(root, 'nope'), 90, '2026-08-26')).toEqual({ removedDays: 0 });
  });

  it('reports file count and bytes', () => {
    seed('Work', 'brain-index', '2026-08-20', 'a.jsonl', 'hello');
    seed('Personal', 'session-summarization', '2026-08-21', 'b.jsonl', 'hi');
    expect(internalArchiveStats(root)).toEqual({ files: 2, bytes: 7 });
  });

  it('clear removes every transcript but leaves the root', () => {
    seed('Work', 'brain-index', '2026-08-20');
    clearInternalArchive(root);
    expect(internalArchiveStats(root)).toEqual({ files: 0, bytes: 0 });
    expect(fs.existsSync(root)).toBe(true);
  });
});

describe('pruning never erases accounted-for spend', () => {
  let root: string;
  let db: Database;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-arch-cost-'));
    db = createDatabase(':memory:');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    db.close();
  });

  // THE test. A finite archive plus a single accounting path is only safe if
  // this holds -- otherwise every prune quietly rewrites history downwards.
  it('keeps the cost rows after the transcript is pruned, even across a rescan', () => {
    const dir = path.join(root, 'Work', 'brain-index', '2026-05-01');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'abc.jsonl'), `${JSON.stringify({
      type: 'assistant',
      requestId: 'r1',
      timestamp: '2026-05-01T12:00:00.000Z',
      message: {
        id: 'm1', model: 'claude-sonnet-5', role: 'assistant',
        usage: { input_tokens: 0, output_tokens: 1_000_000 },
      },
    })}\n`, 'utf-8');

    const svc = createCostHistoryService(db, nodeCostFs);
    svc.backfill([], { archiveRoot: root });
    const before = db.raw.prepare('SELECT SUM(cost_usd) AS t FROM session_cost_daily').get() as { t: number };
    expect(before.t).toBeGreaterThan(0);

    pruneInternalArchive(root, 1, '2026-08-26');
    expect(fs.existsSync(dir)).toBe(false);

    // A rescan visits what it finds. It must not delete rows for what is gone.
    svc.backfill([], { archiveRoot: root });
    const after = db.raw.prepare('SELECT SUM(cost_usd) AS t FROM session_cost_daily').get() as { t: number };
    expect(after.t).toBe(before.t);
  });
});
