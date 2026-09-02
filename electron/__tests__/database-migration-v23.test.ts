import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, runMigrations, type Database } from '../services/database';

/**
 * v23 records WHICH OmniFex-internal activity paid for a cost row.
 *
 * OmniFex spends on the user's account through the CLI — session summaries,
 * Brain indexing, Brain curation — and those transcripts are now retained
 * rather than swept. Folding them into the Cost Report is only useful if each
 * one says what it was, so `internal_kind` carries the answer.
 *
 * Nullable, and NULL means "a real user session". That is what keeps every
 * existing row and every existing query meaning exactly what it meant before.
 */
describe('session_cost_daily.internal_kind (v23)', () => {
  let db: Database;

  beforeEach(() => { db = createDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  function columns(): string[] {
    return (db.raw.prepare('PRAGMA table_info(session_cost_daily)').all() as Array<{ name: string }>)
      .map((c) => c.name);
  }

  it('adds the column', () => {
    expect(columns()).toContain('internal_kind');
  });

  it('defaults to NULL, so an ordinary session row is unchanged', () => {
    db.raw.prepare(`
      INSERT INTO session_cost_daily (
        session_id, date, model, account_name, config_dir, project_path,
        is_subagent, request_count,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m_tokens, cache_write_1h_tokens,
        input_usd, output_usd, cache_read_usd, cache_write_usd,
        cost_usd, is_estimated, updated_at
      ) VALUES ('s1','2026-08-26','claude-opus-5','Work','/cfg','/p',0,1,0,0,0,0,0,0,0,0,0,1.0,0,'now')
    `).run();
    const row = db.raw
      .prepare('SELECT internal_kind FROM session_cost_daily WHERE session_id = ?')
      .get('s1') as { internal_kind: string | null };
    expect(row.internal_kind).toBeNull();
  });

  it('stores a kind when one is given', () => {
    db.raw.prepare(`
      INSERT INTO session_cost_daily (
        session_id, date, model, account_name, config_dir, project_path,
        is_subagent, request_count,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m_tokens, cache_write_1h_tokens,
        input_usd, output_usd, cache_read_usd, cache_write_usd,
        cost_usd, is_estimated, updated_at, internal_kind
      ) VALUES ('s2','2026-08-26','claude-sonnet-5','Work','/cfg','OmniFex/Brain index',
                0,1,0,0,0,0,0,0,0,0,0,0.5,0,'now','brain-index')
    `).run();
    const row = db.raw
      .prepare('SELECT internal_kind FROM session_cost_daily WHERE session_id = ?')
      .get('s2') as { internal_kind: string | null };
    expect(row.internal_kind).toBe('brain-index');
  });

  // Migration 16 creates this table with CREATE TABLE IF NOT EXISTS, so the
  // runner can legitimately be pointed at an image that does not have it yet.
  // Migration 22 had to learn this the hard way; 23 must not relearn it.
  it('is a no-op against an image with no session_cost_daily', () => {
    // Not an empty database — that fails on a much earlier migration and would
    // prove nothing about this one. Drop just the table 23 touches, then
    // re-run: the guard is what has to keep this from throwing.
    db.raw.exec('DROP TABLE session_cost_daily');
    // `>=`, not `= 23`: runMigrations gates on MAX(version), so clearing only
    // this row leaves the max at the newest migration and 23 never re-runs.
    // The `=` form silently stopped testing anything the moment a later
    // migration was added.
    db.raw.prepare('DELETE FROM schema_version WHERE version >= 23').run();
    expect(() => runMigrations(db.raw)).not.toThrow();
  });

  it('is idempotent', () => {
    expect(() => runMigrations(db.raw)).not.toThrow();
    expect(columns().filter((c) => c === 'internal_kind')).toHaveLength(1);
  });
});
