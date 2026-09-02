import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, runMigrations, type Database } from '../services/database';

/**
 * v24 repairs the history the sweep left behind.
 *
 * Before transcripts were retained, OmniFex's internal runs were deleted the
 * moment the call returned — but the cost watcher sometimes got there first,
 * so `session_cost_daily` holds a NON-DETERMINISTIC fraction of that spend
 * under the scratch project path. That is not data; it is whatever won a race.
 *
 * Those rows are dropped and replaced with the Brain's own ledger, which
 * recorded every indexing and curation run exactly. Pre-change session
 * summarization is NOT recoverable — those transcripts are gone and nothing
 * else recorded them — and this migration does not invent a figure for it.
 */
describe('historical internal spend reconciliation (v24)', () => {
  let db: Database;

  beforeEach(() => { db = createDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  function insertScratchRow(sessionId: string, cost: number): void {
    db.raw.prepare(`
      INSERT INTO session_cost_daily (
        session_id, date, model, account_name, config_dir, project_path,
        is_subagent, request_count, input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m_tokens, cache_write_1h_tokens,
        input_usd, output_usd, cache_read_usd, cache_write_usd,
        cost_usd, is_estimated, updated_at
      ) VALUES (?, '2026-08-13','claude-sonnet-5','Work','/cfg',
        '/private/var/folders/x/T/omnifex-summary-scratch',
        0,1,0,0,0,0,0,0,0,0,0,?,0,'now')
    `).run(sessionId, cost);
  }

  function insertLedger(id: number, kind: string, cost: number): void {
    db.raw.prepare(`
      INSERT INTO brain_spend (
        id, account_id, account_name, kind, source_id, item_key, model,
        date, spent_at, input_tokens, output_tokens, cache_read_tokens,
        cache_creation_tokens, cost_usd
      ) VALUES (?, 2, 'Work', ?, 'session', ?, 'claude-sonnet-5',
        '2026-08-13','2026-08-13T20:29:06.391Z', 2, 9384, 3289, 61339, ?)
    `).run(id, kind, `item-${id}`, cost);
  }

  function rerun(): void {
    // `>=`, not `= 24`: runMigrations gates on MAX(version), so clearing only
    // this row leaves the max at the newest migration and 24 never re-runs.
    // The `=` form silently stopped testing anything the moment a later
    // migration was added.
    db.raw.prepare('DELETE FROM schema_version WHERE version >= 24').run();
    runMigrations(db.raw);
  }

  it('removes the racy scratch-derived rows', () => {
    insertScratchRow('racy-1', 16.08);
    rerun();
    const left = db.raw
      .prepare("SELECT COUNT(*) AS n FROM session_cost_daily WHERE project_path LIKE '%omnifex-summary-scratch%'")
      .get() as { n: number };
    expect(left.n).toBe(0);
  });

  it('replaces them with the ledger, attributed per kind', () => {
    insertLedger(1, 'index', 0.51);
    insertLedger(2, 'curation', 0.97);
    rerun();
    const rows = db.raw
      .prepare('SELECT account_name, project_path, internal_kind, cost_usd FROM session_cost_daily ORDER BY internal_kind')
      .all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { account_name: 'Work', project_path: 'OmniFex/Brain curation', internal_kind: 'brain-curation', cost_usd: 0.97 },
      { account_name: 'Work', project_path: 'OmniFex/Brain index', internal_kind: 'brain-index', cost_usd: 0.51 },
    ]);
  });

  it('does not double the ledger rows when re-run', () => {
    insertLedger(1, 'index', 0.51);
    rerun();
    rerun();
    const n = db.raw
      .prepare("SELECT COUNT(*) AS n FROM session_cost_daily WHERE internal_kind = 'brain-index'")
      .get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('leaves ordinary session rows alone', () => {
    db.raw.prepare(`
      INSERT INTO session_cost_daily (
        session_id, date, model, account_name, config_dir, project_path,
        is_subagent, request_count, input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m_tokens, cache_write_1h_tokens,
        input_usd, output_usd, cache_read_usd, cache_write_usd,
        cost_usd, is_estimated, updated_at
      ) VALUES ('real','2026-08-13','claude-opus-5','Work','/cfg','/Users/me/repo',
        0,1,0,0,0,0,0,0,0,0,0,42.0,0,'now')
    `).run();
    rerun();
    const row = db.raw
      .prepare("SELECT cost_usd, internal_kind FROM session_cost_daily WHERE session_id = 'real'")
      .get() as { cost_usd: number; internal_kind: string | null };
    expect(row).toEqual({ cost_usd: 42.0, internal_kind: null });
  });
});
