import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getHandlerMap } from '../ipc/handlers';
import { INVOKE_CHANNELS } from '../ipc/channels';
import { createDatabase, type Database } from '../services/database';
import { createCostHistoryService, type CostHistoryService } from '../services/cost/cost-history';
import type { SessionCostDailyRow } from '../services/cost/session-cost-core';

/**
 * The handler layer between the renderer and cost-history.ts: param
 * normalisation (camelCase / snake_case, arrays, booleans) and the adapter
 * wiring. The service's own tests use its typed API directly, so nothing else
 * exercises this hop — and a channel that is registered but drops a filter
 * looks exactly like a service bug from the UI.
 */

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

/** The `cost:` adapter exactly as electron/main.ts builds it. */
function costAdapter(svc: CostHistoryService) {
  const g = (f: Record<string, unknown>) => ((f.groupBy as string) ?? 'day') as 'day' | 'week' | 'month';
  return {
    get: () => null,
    watch: () => null,
    unwatch: () => null,
    history: (f: Record<string, unknown>) => svc.aggregate(f as never, g(f)),
    historyByModel: (f: Record<string, unknown>) => svc.aggregateByModel(f as never, g(f)),
    sessions: (f: Record<string, unknown>) => svc.sessions(f as never),
    byProject: (f: Record<string, unknown>) => svc.byProject(f as never),
    byModel: (f: Record<string, unknown>) => svc.byModel(f as never),
    byProjectModel: (f: Record<string, unknown>) => svc.byProjectModel(f as never),
    components: (f: Record<string, unknown>) => svc.components(f as never),
    cachingRoi: (f: Record<string, unknown>) => svc.cachingRoi(f as never),
    subagentSplit: (f: Record<string, unknown>) => svc.subagentSplit(f as never),
    unpriced: (f: Record<string, unknown>) => svc.unpriced(f as never),
    facets: (f: Record<string, unknown>) => svc.facets(f as never),
    rescan: () => ({ sessionsScanned: 0 }),
  };
}

const COST_REPORT_CHANNELS = [
  'session_cost_history_by_model',
  'session_cost_by_project',
  'session_cost_by_model',
  'session_cost_by_project_model',
  'session_cost_components',
  'session_cost_caching_roi',
  'session_cost_subagent_split',
  'session_cost_unpriced',
  'session_cost_facets',
];

describe('Cost Report IPC handlers', () => {
  let db: Database;
  let handlers: ReturnType<typeof getHandlerMap>;

  beforeEach(() => {
    db = createDatabase(':memory:');
    const svc = createCostHistoryService(db);
    svc.replaceSession('s1', [
      row({ cost_usd: 10, request_count: 5, cache_read_tokens: 1_000_000, cache_write_5m_tokens: 50_000, cache_read_usd: 6, output_usd: 4 }),
      row({ is_subagent: 1, cost_usd: 2, request_count: 8, output_usd: 2 }),
    ]);
    svc.replaceSession('s2', [
      row({ session_id: 's2', date: '2026-08-02', model: 'claude-sonnet-5', account_name: 'Personal', project_path: '/Users/me/beta', cost_usd: 5, request_count: 3, output_usd: 5 }),
    ]);
    handlers = getHandlerMap({ cost: costAdapter(svc) } as never);
  });
  afterEach(() => { db.close(); });

  const call = (channel: string, params?: Record<string, unknown>) =>
    handlers[channel](null, params);

  it('registers every Cost Report channel, and each is allow-listed', () => {
    for (const ch of COST_REPORT_CHANNELS) {
      expect(handlers[ch], `${ch} has no handler`).toBeTypeOf('function');
      expect(INVOKE_CHANNELS, `${ch} missing from preload allow-list`).toContain(ch);
    }
  });

  it('accepts snake_case params as well as camelCase', async () => {
    const camel = await call('session_cost_by_model', { accountName: 'Work', startDate: '2026-08-01' });
    const snake = await call('session_cost_by_model', { account_name: 'Work', start_date: '2026-08-01' });
    expect(snake).toEqual(camel);
    expect((camel as Array<{ cost_usd: number }>)[0].cost_usd).toBeCloseTo(12, 10);
  });

  it('carries array filters through the handler rather than flattening them', async () => {
    const both = await call('session_cost_by_model', { accountName: ['Work', 'Personal'] });
    expect((both as unknown[]).length).toBe(2);
    const one = await call('session_cost_by_model', { accountName: ['Personal'] });
    expect((one as unknown[]).length).toBe(1);
  });

  it('carries isSubagent, including the false case', async () => {
    // `false` is the value most likely to be lost to a truthiness check, and
    // losing it silently shows subagent spend inside the main-loop total.
    // Main loop across BOTH sessions: s1's $10/5 plus s2's $5/3.
    const main = await call('session_cost_subagent_split', { isSubagent: false });
    expect(main).toEqual([{ is_subagent: 0, cost_usd: 15, request_count: 8, usd_per_request: 15 / 8 }]);
    const sub = await call('session_cost_subagent_split', { is_subagent: true });
    expect((sub as Array<{ is_subagent: number }>)[0].is_subagent).toBe(1);
  });

  it('returns the component split and caching ROI as objects, not arrays', async () => {
    const c = await call('session_cost_components', {}) as { cost_usd: number; context_share: number };
    expect(c.cost_usd).toBeCloseTo(17, 10);
    expect(c.context_share).toBeGreaterThan(0);
    const roi = await call('session_cost_caching_roi', {}) as { read_write_ratio: number };
    expect(roi.read_write_ratio).toBeCloseTo(20, 10);
  });

  it('groups history by model and period', async () => {
    const r = await call('session_cost_history_by_model', { groupBy: 'day' }) as Array<{ period: string; model: string }>;
    expect(r.map((x) => `${x.period}|${x.model}`)).toEqual([
      '2026-08-01|claude-opus-5',
      '2026-08-02|claude-sonnet-5',
    ]);
  });

  it('returns facets for the filter controls', async () => {
    const f = await call('session_cost_facets', {}) as { accounts: string[]; minDate: string };
    expect(f.accounts).toEqual(['Personal', 'Work']);
    expect(f.minDate).toBe('2026-08-01');
  });

  // Every handler resolves rather than throwing when its service is absent —
  // the renderer gets a defined empty response instead of a blocked channel.
  it('degrades to empty when the cost service is not wired', async () => {
    const bare = getHandlerMap({});
    for (const ch of COST_REPORT_CHANNELS) {
      await expect(bare[ch](null, {})).resolves.toBeDefined();
    }
  });
});
