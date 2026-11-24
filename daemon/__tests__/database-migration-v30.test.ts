import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, runMigrations, type Database } from '../services/database';

describe('v24 ledger backfill removed (v30)', () => {
  let db: Database;

  beforeEach(() => { db = createDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  function insertRow(sessionId: string, projectPath: string, kind: string | null): void {
    db.raw.prepare(`
      INSERT INTO session_cost_daily (
        session_id, date, model, account_name, config_dir, project_path,
        is_subagent, request_count, cost_usd, is_estimated, updated_at, internal_kind
      ) VALUES (?, '2026-08-13', 'claude-sonnet-5', 'Work', '', ?, 0, 1, 1.5, 0, 'now', ?)
    `).run(sessionId, projectPath, kind);
  }

  const ids = () =>
    (db.raw.prepare('SELECT session_id FROM session_cost_daily ORDER BY session_id').all() as { session_id: string }[])
      .map((r) => r.session_id);

  it('deletes the brain-spend ledger rows and keeps transcript-priced rows', () => {
    insertRow('brain-spend-7', 'OmniFex/Brain index', 'brain-index');
    insertRow('3f1c-transcript', '/private/var/folders/x/T/omnifex-summary-scratch', null);
    insertRow('user-session', '/Users/me/repo', null);

    // `>=`: runMigrations gates on MAX(version).
    db.raw.prepare('DELETE FROM schema_version WHERE version >= 30').run();
    runMigrations(db.raw);

    expect(ids()).toEqual(['3f1c-transcript', 'user-session']);
  });
});
