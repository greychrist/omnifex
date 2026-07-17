import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createCostHistoryService, type CostFs } from '../services/cost/cost-history';
import type { SessionCostDailyRow } from '../services/cost/session-cost-core';

function row(partial: Partial<SessionCostDailyRow>): SessionCostDailyRow {
  return {
    session_id: 's1',
    date: '2026-07-17',
    model: 'claude-opus-4-8',
    account_name: 'Work',
    config_dir: '/cfg',
    project_path: '/Users/me/proj',
    input_tokens: 10,
    output_tokens: 100,
    cache_read_tokens: 0,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cost_usd: 1.5,
    is_estimated: 0,
    ...partial,
  };
}

describe('cost-history', () => {
  let db: Database;
  beforeEach(() => { db = createDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  it('migration creates session_cost_daily', () => {
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_cost_daily'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('replaceSession is idempotent and removes stale rows', () => {
    const svc = createCostHistoryService(db);
    svc.replaceSession('s1', [row({ date: '2026-07-16' }), row({ date: '2026-07-17' })]);
    svc.replaceSession('s1', [row({ date: '2026-07-17', cost_usd: 2.0 })]);
    const all = db.raw.prepare('SELECT * FROM session_cost_daily').all() as SessionCostDailyRow[];
    expect(all).toHaveLength(1);
    expect(all[0].cost_usd).toBeCloseTo(2.0, 10);
  });

  it('aggregate groups by day/month and applies filters', () => {
    const svc = createCostHistoryService(db);
    svc.replaceSession('s1', [row({ date: '2026-06-30', cost_usd: 1 })]);
    svc.replaceSession('s2', [
      row({ session_id: 's2', date: '2026-07-01', cost_usd: 2 }),
      row({ session_id: 's2', date: '2026-07-02', cost_usd: 4, account_name: 'Personal' }),
    ]);
    const months = svc.aggregate({}, 'month');
    expect(months.map((m) => m.period)).toEqual(['2026-06', '2026-07']);
    expect(months[1].cost_usd).toBeCloseTo(6, 10);

    const filtered = svc.aggregate({ accountName: 'Work', startDate: '2026-07-01' }, 'day');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].period).toBe('2026-07-01');
  });

  it('sessions rolls up per session ordered by cost', () => {
    const svc = createCostHistoryService(db);
    svc.replaceSession('cheap', [row({ session_id: 'cheap', cost_usd: 1 })]);
    svc.replaceSession('spendy', [
      row({ session_id: 'spendy', date: '2026-07-16', cost_usd: 5 }),
      row({ session_id: 'spendy', date: '2026-07-17', cost_usd: 5 }),
    ]);
    const sessions = svc.sessions({});
    expect(sessions[0].session_id).toBe('spendy');
    expect(sessions[0].cost_usd).toBeCloseTo(10, 10);
    expect(sessions[0].first_date).toBe('2026-07-16');
    expect(sessions[0].last_date).toBe('2026-07-17');
  });

  it('backfill walks config dirs incl. subagents and upserts', () => {
    const CFG = '/cfg';
    const PROJ_DIR = path.join(CFG, 'projects', '-Users-me-proj');
    const sessionLine = JSON.stringify({
      type: 'assistant', requestId: 'r1', timestamp: '2026-07-17T01:00:00Z', cwd: '/Users/me/proj',
      message: { id: 'm1', model: 'claude-opus-4-8', usage: { output_tokens: 1000 } },
    });
    const subLine = JSON.stringify({
      type: 'assistant', requestId: 'r_sub', timestamp: '2026-07-17T01:05:00Z',
      message: { id: 'm2', model: 'claude-haiku-4-5', usage: { output_tokens: 500 } },
    });
    const files: Record<string, string> = {
      [path.join(PROJ_DIR, 'sessA.jsonl')]: sessionLine,
      [path.join(PROJ_DIR, 'sessA', 'subagents', 'agent-x1.jsonl')]: subLine,
    };
    const dirs: Record<string, Array<{ name: string; isDirectory: boolean }>> = {
      [path.join(CFG, 'projects')]: [{ name: '-Users-me-proj', isDirectory: true }],
      [PROJ_DIR]: [
        { name: 'sessA.jsonl', isDirectory: false },
        { name: 'sessA', isDirectory: true },
      ],
      [path.join(PROJ_DIR, 'sessA', 'subagents')]: [{ name: 'agent-x1.jsonl', isDirectory: false }],
    };
    const fakeFs: CostFs = {
      readFile: (p) => files[p] ?? null,
      listDir: (p) => dirs[p] ?? [],
    };
    const svc = createCostHistoryService(db, fakeFs);
    const result = svc.backfill([{ name: 'Work', config_dir: CFG }]);
    expect(result.sessionsScanned).toBe(1);
    const rows = db.raw.prepare('SELECT * FROM session_cost_daily ORDER BY model').all() as SessionCostDailyRow[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.model)).toEqual(['claude-haiku-4-5', 'claude-opus-4-8']);
    expect(rows[1].project_path).toBe('/Users/me/proj');
    expect(rows[1].session_id).toBe('sessA');
  });
});
