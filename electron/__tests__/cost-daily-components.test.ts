import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database_ from 'better-sqlite3';
import { createDatabase, type Database } from '../services/database';
import { createCostHistoryService, type CostFs } from '../services/cost/cost-history';
import { computeSessionCost, type SessionCostDailyRow } from '../services/cost/session-cost-core';

/**
 * Migration 22 splits main-loop and subagent spend into separate rows and
 * persists the component cost breakdown that `computeSessionCost` was already
 * calculating and discarding.
 *
 * The split lives in the PRIMARY KEY rather than in a pair of `subagent_*`
 * columns so that EVERY metric splits — tokens, requests, cache ratios — for
 * one column instead of eight, and so main-vs-subagent is an ordinary WHERE
 * clause rather than a special-cased display mode.
 */

const CFG = '/cfg';
const PROJ_DIR = path.join(CFG, 'projects', '-Users-me-proj');
const SUBAGENTS = path.join(PROJ_DIR, 'sessA', 'subagents');

function line(id: string, opts: { output?: number; cacheRead?: number; cw5m?: number; cw1h?: number; input?: number; model?: string; ts?: string } = {}): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: `r-${id}`,
    timestamp: opts.ts ?? '2026-08-17T01:00:00Z',
    cwd: '/Users/me/proj',
    message: {
      id,
      model: opts.model ?? 'claude-opus-4-8',
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation: {
          ephemeral_5m_input_tokens: opts.cw5m ?? 0,
          ephemeral_1h_input_tokens: opts.cw1h ?? 0,
        },
      },
    },
  });
}

describe('session_cost_daily component + subagent columns', () => {
  let db: Database;
  beforeEach(() => { db = createDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  it('has the new columns and is_subagent in the primary key', () => {
    const cols = (db.raw.prepare('PRAGMA table_info(session_cost_daily)').all() as Array<{ name: string; pk: number }>);
    const names = cols.map((c) => c.name);
    for (const c of ['is_subagent', 'request_count', 'input_usd', 'output_usd', 'cache_read_usd', 'cache_write_usd']) {
      expect(names).toContain(c);
    }
    const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    expect(pk).toEqual(['session_id', 'date', 'model', 'is_subagent']);
  });

  it('keeps the date and account indexes after the table rebuild', () => {
    const idx = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_cost_daily'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(idx).toContain('idx_session_cost_daily_date');
    expect(idx).toContain('idx_session_cost_daily_account');
  });

  it('splits main-loop and subagent spend into separate rows for the same day+model', () => {
    const files: Record<string, string> = {
      [path.join(PROJ_DIR, 'sessA.jsonl')]: line('m-main', { output: 1000 }),
      [path.join(SUBAGENTS, 'agent-a.jsonl')]: line('m-sub', { output: 4000 }),
    };
    const dirs: Record<string, Array<{ name: string; isDirectory: boolean }>> = {
      [path.join(CFG, 'projects')]: [{ name: '-Users-me-proj', isDirectory: true }],
      [PROJ_DIR]: [{ name: 'sessA.jsonl', isDirectory: false }, { name: 'sessA', isDirectory: true }],
      [SUBAGENTS]: [{ name: 'agent-a.jsonl', isDirectory: false }],
    };
    const fakeFs: CostFs = {
      readFile: (p) => files[p] ?? null,
      listDir: (p) => dirs[p] ?? [],
      stat: (p) => (p in files ? { mtimeMs: files[p].length, size: files[p].length } : null),
    };
    createCostHistoryService(db, fakeFs).backfill([{ name: 'Work', config_dir: CFG }]);

    const rows = db.raw
      .prepare('SELECT * FROM session_cost_daily ORDER BY is_subagent')
      .all() as SessionCostDailyRow[];
    expect(rows).toHaveLength(2);
    expect(rows[0].is_subagent).toBe(0);
    expect(rows[0].output_tokens).toBe(1000);
    expect(rows[1].is_subagent).toBe(1);
    expect(rows[1].output_tokens).toBe(4000);
    // Same session, date and model on both — only is_subagent separates them,
    // which is exactly what the widened primary key has to allow.
    expect(rows[0].date).toBe(rows[1].date);
    expect(rows[0].model).toBe(rows[1].model);
  });

  it('counts requests per row', () => {
    const { dailyRows } = computeSessionCost({
      sessionContent: [line('m1', { output: 10 }), line('m2', { output: 20 }), line('m3', { output: 30 })].join('\n'),
      subagentContents: [[line('s1', { output: 1 }), line('s2', { output: 2 })].join('\n')],
      sessionId: 'sessA', accountName: 'Work', configDir: CFG, projectPath: '/Users/me/proj',
    });
    const main = dailyRows.find((r) => r.is_subagent === 0)!;
    const sub = dailyRows.find((r) => r.is_subagent === 1)!;
    expect(main.request_count).toBe(3);
    expect(sub.request_count).toBe(2);
  });

  it('persists the component split, and the parts sum to cost_usd', () => {
    const { dailyRows, snapshot } = computeSessionCost({
      sessionContent: line('m1', { input: 5_000, output: 20_000, cacheRead: 900_000, cw5m: 30_000, cw1h: 10_000 }),
      subagentContents: [],
      sessionId: 'sessA', accountName: 'Work', configDir: CFG, projectPath: '/Users/me/proj',
    });
    const r = dailyRows[0];
    expect(r.input_usd + r.output_usd + r.cache_read_usd + r.cache_write_usd).toBeCloseTo(r.cost_usd, 10);
    // and they match what the live snapshot reports, since both come from the
    // same computeMessageCost call
    expect(r.input_usd).toBeCloseTo(snapshot.breakdown.inputUsd, 10);
    expect(r.output_usd).toBeCloseTo(snapshot.breakdown.outputUsd, 10);
    expect(r.cache_read_usd).toBeCloseTo(snapshot.breakdown.cacheReadUsd, 10);
    expect(r.cache_write_usd).toBeCloseTo(snapshot.breakdown.cacheWriteUsd, 10);
  });

  it('component costs are stored, not recomputed — a later rate change cannot desync them', () => {
    // The point of persisting the split: if the page recomputed it from tokens
    // at current rates, the parts would stop summing to the stored whole the
    // moment a price changed, and would disagree silently.
    const svc = createCostHistoryService(db);
    svc.replaceSession('s1', [{
      session_id: 's1', date: '2026-08-01', model: 'claude-opus-4-8', account_name: 'Work',
      config_dir: CFG, project_path: '/p', is_subagent: 0, request_count: 4,
      input_tokens: 1, output_tokens: 2, cache_read_tokens: 3,
      cache_write_5m_tokens: 4, cache_write_1h_tokens: 5,
      input_usd: 0.25, output_usd: 0.5, cache_read_usd: 1.0, cache_write_usd: 2.25,
      cost_usd: 4.0, is_estimated: 0,
    }]);
    const [row] = db.raw.prepare('SELECT * FROM session_cost_daily').all() as SessionCostDailyRow[];
    expect(row.input_usd + row.output_usd + row.cache_read_usd + row.cache_write_usd).toBeCloseTo(4.0, 10);
    expect(row.request_count).toBe(4);
  });

  it('backfilling twice produces identical rows', () => {
    const files: Record<string, string> = {
      [path.join(PROJ_DIR, 'sessA.jsonl')]: line('m-main', { output: 1000, cacheRead: 5000 }),
      [path.join(SUBAGENTS, 'agent-a.jsonl')]: line('m-sub', { output: 4000 }),
    };
    const dirs: Record<string, Array<{ name: string; isDirectory: boolean }>> = {
      [path.join(CFG, 'projects')]: [{ name: '-Users-me-proj', isDirectory: true }],
      [PROJ_DIR]: [{ name: 'sessA.jsonl', isDirectory: false }, { name: 'sessA', isDirectory: true }],
      [SUBAGENTS]: [{ name: 'agent-a.jsonl', isDirectory: false }],
    };
    const fakeFs: CostFs = {
      readFile: (p) => files[p] ?? null,
      listDir: (p) => dirs[p] ?? [],
      stat: (p) => (p in files ? { mtimeMs: files[p].length, size: files[p].length } : null),
    };
    const snap = () => JSON.stringify(
      db.raw.prepare('SELECT session_id,date,model,is_subagent,request_count,input_tokens,output_tokens,cost_usd,input_usd,output_usd,cache_read_usd,cache_write_usd FROM session_cost_daily ORDER BY session_id,date,model,is_subagent').all(),
    );
    createCostHistoryService(db, fakeFs).backfill([{ name: 'Work', config_dir: CFG }]);
    const first = snap();
    createCostHistoryService(db, fakeFs).backfill([{ name: 'Work', config_dir: CFG }]);
    expect(snap()).toBe(first);
  });
});

describe('migration 22 rebuild', () => {
  /** Build a v21-era database on disk, then let createDatabase migrate it.
   *  SQLite cannot widen a primary key in place, so migration 22 rebuilds the
   *  table — and a rebuild is the migration shape most likely to lose rows or
   *  silently drop indexes (see migration 21's note on renamed tables). */
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-mig22-'));
    file = path.join(dir, 'test.db');
    const raw = new Database_(file);
    raw.exec(`
      CREATE TABLE session_cost_daily (
        session_id TEXT NOT NULL, date TEXT NOT NULL, model TEXT NOT NULL,
        account_name TEXT NOT NULL, config_dir TEXT NOT NULL, project_path TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL, is_estimated INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, date, model)
      );
      CREATE INDEX idx_session_cost_daily_date ON session_cost_daily(date);
      CREATE INDEX idx_session_cost_daily_account ON session_cost_daily(account_name, date);
      INSERT INTO session_cost_daily VALUES
        ('s1','2026-07-01','claude-opus-4-8','Work','/cfg','/p',1,2,3,4,5,12.5,0,'2026-07-01T00:00:00Z'),
        ('s2','2026-07-02','claude-sonnet-5','Personal','/cfg2','/q',6,7,8,9,10,3.25,1,'2026-07-02T00:00:00Z');
    `);
    raw.close();
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('preserves pre-migration rows, totals and indexes', () => {
    const db = createDatabase(file);
    const rows = db.raw
      .prepare('SELECT * FROM session_cost_daily ORDER BY session_id')
      .all() as SessionCostDailyRow[];
    expect(rows).toHaveLength(2);
    expect(rows[0].cost_usd).toBeCloseTo(12.5, 10);
    expect(rows[1].cost_usd).toBeCloseTo(3.25, 10);
    expect(rows[1].is_estimated).toBe(1);
    expect(rows[0].cache_write_1h_tokens).toBe(5);

    // Pre-migration rows predate the split, so they are all attributed to the
    // main loop and carry no request count or component breakdown until the
    // next backfill sweep re-reads their transcripts.
    expect(rows.every((r) => r.is_subagent === 0)).toBe(true);
    expect(rows.every((r) => r.request_count === 0)).toBe(true);
    expect(rows.every((r) => r.input_usd === 0 && r.cache_read_usd === 0)).toBe(true);

    const idx = (db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_cost_daily'")
      .all() as Array<{ name: string }>).map((r) => r.name);
    expect(idx).toContain('idx_session_cost_daily_date');
    expect(idx).toContain('idx_session_cost_daily_account');

    // The old table must not survive under a renamed alias.
    const leftovers = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'session_cost_daily%'")
      .all() as Array<{ name: string }>;
    expect(leftovers.map((r) => r.name)).toEqual(['session_cost_daily']);
    db.close();
  });

  it('is idempotent — reopening an already-migrated database is a no-op', () => {
    createDatabase(file).close();
    const db = createDatabase(file);
    expect(db.raw.prepare('SELECT COUNT(*) n FROM session_cost_daily').get()).toEqual({ n: 2 });
    db.close();
  });
});
