import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createCostHistoryService, type CostHistoryService } from '../services/cost/cost-history';
import type { SessionCostDailyRow } from '../services/cost/session-cost-core';

function row(p: Partial<SessionCostDailyRow>): SessionCostDailyRow {
  return {
    session_id: 's1', date: '2026-08-01', model: 'claude-opus-5',
    account_name: 'Work', config_dir: '/cfg', project_path: '/Users/me/alpha',
    is_subagent: 0, request_count: 1,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
    cache_write_5m_tokens: 0, cache_write_1h_tokens: 0,
    input_usd: 0, output_usd: 0, cache_read_usd: 0, cache_write_usd: 0,
    cost_usd: 0, is_estimated: 0,
    ...p,
  };
}

/** A small but structurally complete fixture: two accounts, two projects, two
 *  models, both sides of the subagent split. */
function seed(svc: CostHistoryService): void {
  svc.replaceSession('s1', [
    row({ session_id: 's1', date: '2026-08-01', model: 'claude-opus-5', project_path: '/Users/me/alpha', cost_usd: 10, request_count: 5, output_usd: 4, cache_read_usd: 6, cache_read_tokens: 1_000_000, cache_write_5m_tokens: 50_000 }),
    row({ session_id: 's1', date: '2026-08-01', model: 'claude-opus-5', project_path: '/Users/me/alpha', is_subagent: 1, cost_usd: 2, request_count: 8, output_usd: 1, cache_read_usd: 1 }),
  ]);
  svc.replaceSession('s2', [
    row({ session_id: 's2', date: '2026-08-02', model: 'claude-sonnet-5', project_path: '/Users/me/beta', account_name: 'Personal', cost_usd: 5, request_count: 3, output_usd: 5 }),
  ]);
  svc.replaceSession('s3', [
    row({ session_id: 's3', date: '2026-07-30', model: 'claude-opus-5', project_path: '/Users/me/beta', cost_usd: 3, request_count: 2, output_usd: 3 }),
  ]);
}

describe('cost query surface', () => {
  let db: Database;
  let svc: CostHistoryService;
  beforeEach(() => { db = createDatabase(':memory:'); svc = createCostHistoryService(db); seed(svc); });
  afterEach(() => { db.close(); });

  describe('array filters', () => {
    it('accepts a single string, as the existing callers pass', () => {
      expect(svc.byModel({ accountName: 'Work' }).reduce((n, r) => n + r.cost_usd, 0)).toBeCloseTo(15, 10);
    });

    it('accepts an array and ORs the values', () => {
      const all = svc.byModel({ accountName: ['Work', 'Personal'] });
      expect(all.reduce((n, r) => n + r.cost_usd, 0)).toBeCloseTo(20, 10);
    });

    // An empty selection in the UI means "no filter applied", not "match
    // nothing" — a filter bar that renders zero rows the moment you clear a
    // checkbox reads as a bug.
    it('treats an empty array as no filter', () => {
      expect(svc.byModel({ accountName: [] }).reduce((n, r) => n + r.cost_usd, 0)).toBeCloseTo(20, 10);
    });

    it('combines array filters with dates', () => {
      const r = svc.byModel({ model: ['claude-opus-5'], startDate: '2026-08-01' });
      expect(r).toHaveLength(1);
      expect(r[0].cost_usd).toBeCloseTo(12, 10);
    });
  });

  describe('projectSearch', () => {
    it('matches a substring of the project path', () => {
      expect(svc.byProject({ projectSearch: 'alph' })).toHaveLength(1);
      expect(svc.byProject({ projectSearch: 'me/' })).toHaveLength(2);
    });

    it('is case-insensitive', () => {
      expect(svc.byProject({ projectSearch: 'ALPHA' })).toHaveLength(1);
    });

    // A path with a literal % or _ must not turn into a wildcard.
    it('escapes LIKE metacharacters', () => {
      svc.replaceSession('s9', [row({ session_id: 's9', project_path: '/Users/me/a_b', cost_usd: 1 })]);
      expect(svc.byProject({ projectSearch: 'a_b' }).map((r) => r.project_path)).toEqual(['/Users/me/a_b']);
      expect(svc.byProject({ projectSearch: '%' })).toHaveLength(0);
    });
  });

  describe('isSubagent', () => {
    it('undefined includes both sides', () => {
      expect(svc.byModel({ startDate: '2026-08-01', model: 'claude-opus-5' })[0].cost_usd).toBeCloseTo(12, 10);
    });
    it('false selects the main loop only', () => {
      expect(svc.byModel({ startDate: '2026-08-01', model: 'claude-opus-5', isSubagent: false })[0].cost_usd).toBeCloseTo(10, 10);
    });
    it('true selects subagents only', () => {
      expect(svc.byModel({ startDate: '2026-08-01', model: 'claude-opus-5', isSubagent: true })[0].cost_usd).toBeCloseTo(2, 10);
    });
  });

  describe('groupings', () => {
    it('byProject sums per project, most expensive first', () => {
      const r = svc.byProject({});
      expect(r.map((x) => x.project_path)).toEqual(['/Users/me/alpha', '/Users/me/beta']);
      expect(r[0].cost_usd).toBeCloseTo(12, 10);
      expect(r[0].request_count).toBe(13);
      expect(r[1].cost_usd).toBeCloseTo(8, 10);
    });

    it('byModel sums per model', () => {
      const r = svc.byModel({});
      expect(r.find((x) => x.model === 'claude-opus-5')!.cost_usd).toBeCloseTo(15, 10);
      expect(r.find((x) => x.model === 'claude-sonnet-5')!.cost_usd).toBeCloseTo(5, 10);
    });

    it('byProjectModel crosses the two', () => {
      const r = svc.byProjectModel({});
      expect(r).toHaveLength(3);
      const alphaOpus = r.find((x) => x.project_path === '/Users/me/alpha' && x.model === 'claude-opus-5')!;
      expect(alphaOpus.cost_usd).toBeCloseTo(12, 10);
    });

    it('subagentSplit reports cost, requests and cost-per-request per side', () => {
      const r = svc.subagentSplit({ startDate: '2026-08-01', endDate: '2026-08-01' });
      const main = r.find((x) => x.is_subagent === 0)!;
      const sub = r.find((x) => x.is_subagent === 1)!;
      expect(main.cost_usd).toBeCloseTo(10, 10);
      expect(main.request_count).toBe(5);
      expect(main.usd_per_request).toBeCloseTo(2, 10);
      expect(sub.usd_per_request).toBeCloseTo(0.25, 10);
    });
  });

  describe('components', () => {
    it('sums the four stored component columns', () => {
      const c = svc.components({ startDate: '2026-08-01', endDate: '2026-08-01' });
      expect(c.output_usd).toBeCloseTo(5, 10);
      expect(c.cache_read_usd).toBeCloseTo(7, 10);
      expect(c.cost_usd).toBeCloseTo(12, 10);
    });

    it('reports the context share — the number the whole report exists for', () => {
      const c = svc.components({ startDate: '2026-08-01', endDate: '2026-08-01' });
      // input + cacheRead + cacheWrite over the total: 7 of 12.
      expect(c.context_share).toBeCloseTo(7 / 12, 10);
    });

    it('returns zeros rather than nulls when nothing matches', () => {
      const c = svc.components({ startDate: '2030-01-01' });
      expect(c.cost_usd).toBe(0);
      expect(c.context_share).toBe(0);
    });
  });

  describe('cachingRoi', () => {
    it('reports the read:write ratio', () => {
      const roi = svc.cachingRoi({ startDate: '2026-08-01', endDate: '2026-08-01' });
      expect(roi.cache_read_tokens).toBe(1_000_000);
      expect(roi.cache_write_tokens).toBe(50_000);
      expect(roi.read_write_ratio).toBeCloseTo(20, 10);
    });

    // Break-even is around 2:1. Below that, caching costs more than it saves
    // and the UI has to say so rather than printing a number.
    it('flags a ratio at or below break-even', () => {
      const db2 = createDatabase(':memory:');
      const s2 = createCostHistoryService(db2);
      s2.replaceSession('x', [row({ cache_read_tokens: 100, cache_write_5m_tokens: 100, cost_usd: 1 })]);
      expect(s2.cachingRoi({}).read_write_ratio).toBeCloseTo(1, 10);
      expect(s2.cachingRoi({}).below_break_even).toBe(true);
      db2.close();
      expect(svc.cachingRoi({}).below_break_even).toBe(false);
    });

    it('does not divide by zero when nothing was ever written to cache', () => {
      const roi = svc.cachingRoi({ startDate: '2026-07-30', endDate: '2026-07-30' });
      expect(roi.cache_write_tokens).toBe(0);
      expect(Number.isFinite(roi.read_write_ratio)).toBe(true);
      expect(roi.read_write_ratio).toBe(0);
      expect(roi.below_break_even).toBe(false);
    });
  });

  describe('unpriced', () => {
    it('is empty when every model is priced', () => {
      expect(svc.unpriced({})).toEqual([]);
    });

    it('reports estimated rows by model with their record counts', () => {
      svc.replaceSession('s8', [row({ session_id: 's8', model: 'claude-brandnew-9', is_estimated: 1, cost_usd: 3, request_count: 9 })]);
      expect(svc.unpriced({})).toEqual([
        { model: 'claude-brandnew-9', request_count: 9, cost_usd: 3 },
      ]);
    });
  });

  describe('facets', () => {
    it('lists the distinct values available for the filter controls', () => {
      const f = svc.facets({});
      expect(f.accounts).toEqual(['Personal', 'Work']);
      expect(f.models).toEqual(['claude-opus-5', 'claude-sonnet-5']);
      expect(f.projects).toEqual(['/Users/me/alpha', '/Users/me/beta']);
      expect(f.minDate).toBe('2026-07-30');
      expect(f.maxDate).toBe('2026-08-02');
    });

    // Narrowing to one account must not narrow the account list itself, or
    // the control you just used to filter would erase its own alternatives.
    it('keeps the account list whole when an account filter is applied', () => {
      const f = svc.facets({ accountName: 'Work' });
      expect(f.accounts).toEqual(['Personal', 'Work']);
      expect(f.projects).toEqual(['/Users/me/alpha', '/Users/me/beta']);
    });

    it('returns empty lists and null dates on an empty table', () => {
      const db2 = createDatabase(':memory:');
      const f = createCostHistoryService(db2).facets({});
      expect(f).toEqual({ accounts: [], models: [], projects: [], minDate: null, maxDate: null });
      db2.close();
    });
  });

  describe('aggregate', () => {
    it('now carries request_count and the component columns', () => {
      const [p] = svc.aggregate({ startDate: '2026-08-01', endDate: '2026-08-01' }, 'day');
      expect(p.request_count).toBe(13);
      expect(p.output_usd).toBeCloseTo(5, 10);
      expect(p.cache_read_usd).toBeCloseTo(7, 10);
    });

    it('can group by model as well as period, for the stacked chart', () => {
      const r = svc.aggregateByModel({ startDate: '2026-08-01' }, 'day');
      expect(r).toHaveLength(2);
      expect(r.find((x) => x.period === '2026-08-01' && x.model === 'claude-opus-5')!.cost_usd).toBeCloseTo(12, 10);
    });
  });
});

/**
 * Session counts were the one metric the (now removed) Usage dashboard had
 * that the Cost Report did not. Requests and sessions answer different
 * questions — "6,637 requests" and "42 sessions" are both true and neither
 * substitutes for the other.
 */
describe('session counts', () => {
  let db: Database;
  let svc: CostHistoryService;
  beforeEach(() => { db = createDatabase(':memory:'); svc = createCostHistoryService(db); seed(svc); });
  afterEach(() => { db.close(); });

  it('counts distinct sessions per project', () => {
    const r = svc.byProject({});
    expect(r.find((x) => x.project_path === '/Users/me/alpha')!.session_count).toBe(1);
    // beta is touched by two different sessions (s2 and s3).
    expect(r.find((x) => x.project_path === '/Users/me/beta')!.session_count).toBe(2);
  });

  it('counts distinct sessions per model', () => {
    expect(svc.byModel({}).find((x) => x.model === 'claude-opus-5')!.session_count).toBe(2);
  });

  it('counts distinct sessions per period', () => {
    const [p] = svc.aggregate({ startDate: '2026-08-01', endDate: '2026-08-01' }, 'day');
    expect(p.session_count).toBe(1);
  });

  // A session spanning two days must not be counted twice in the range total,
  // which is exactly what SUM over per-period counts would do.
  it('does not double-count a session that spans periods', () => {
    svc.replaceSession('span', [
      row({ session_id: 'span', date: '2026-08-05', cost_usd: 1 }),
      row({ session_id: 'span', date: '2026-08-06', cost_usd: 1 }),
    ]);
    expect(svc.totals({ startDate: '2026-08-05' }).session_count).toBe(1);
    expect(svc.aggregate({ startDate: '2026-08-05' }, 'day').reduce((n, p) => n + p.session_count, 0)).toBe(2);
  });

  it('totals() reports range-wide distinct sessions, requests and cost', () => {
    const t = svc.totals({});
    expect(t.session_count).toBe(3);
    expect(t.request_count).toBe(18); // s1 5 + 8, s2 3, s3 2
    expect(t.cost_usd).toBeCloseTo(20, 10);
  });
});
