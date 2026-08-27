import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createCostHistoryService, type CostFs } from '../services/cost/cost-history';

/**
 * OmniFex's own CLI runs are now retained, so the cost table has to price
 * them and say what they were.
 *
 * The transcripts are ordinary CLI JSONL — the same parser, the same pricing.
 * What is different is attribution: the account and kind come from the archive
 * path (ownership by location, the rule the Brain already uses), and the
 * project path is a display label rather than a real directory.
 */

/** One deduped assistant record: 1M output tokens of Sonnet 5 = $10.00. */
function transcript(sessionId: string, date: string): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: `req-${sessionId}`,
    timestamp: `${date}T12:00:00.000Z`,
    sessionId,
    cwd: '/private/tmp/omnifex-summary-scratch',
    message: {
      id: `msg-${sessionId}`,
      model: 'claude-sonnet-5',
      role: 'assistant',
      usage: { input_tokens: 0, output_tokens: 1_000_000, cache_read_input_tokens: 0 },
    },
  });
}

/** In-memory CostFs over a flat path -> contents map. */
function fakeFs(files: Record<string, string>): CostFs {
  const dirsOf = (dir: string) => {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const seen = new Map<string, boolean>();
    for (const p of Object.keys(files)) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) seen.set(rest, false);
      else seen.set(rest.slice(0, slash), true);
    }
    return [...seen].map(([name, isDirectory]) => ({ name, isDirectory }));
  };
  return {
    listDir: (dir) => dirsOf(dir),
    readFile: (p) => files[p] ?? null,
    stat: (p) => (files[p] === undefined ? null : { size: files[p].length, mtimeMs: 1 }),
  };
}

describe('cost ingest over the internal archive', () => {
  let db: Database;

  beforeEach(() => { db = createDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  const ARCHIVE = '/u/internal-sessions';

  function rows() {
    return db.raw
      .prepare('SELECT session_id, account_name, project_path, internal_kind, model, cost_usd FROM session_cost_daily ORDER BY session_id')
      .all() as Array<Record<string, unknown>>;
  }

  it('prices an archived transcript and says which activity paid for it', () => {
    const fs = fakeFs({
      [`${ARCHIVE}/Work/brain-index/2026-08-26/abc.jsonl`]: transcript('abc', '2026-08-26'),
    });
    const svc = createCostHistoryService(db, fs);
    svc.backfill([], { archiveRoot: ARCHIVE });

    expect(rows()).toEqual([
      {
        session_id: 'abc',
        account_name: 'Work',
        project_path: 'OmniFex/Brain index',
        internal_kind: 'brain-index',
        model: 'claude-sonnet-5',
        cost_usd: 10,
      },
    ]);
  });

  it('attributes each kind separately', () => {
    const fs = fakeFs({
      [`${ARCHIVE}/Work/brain-index/2026-08-26/a.jsonl`]: transcript('a', '2026-08-26'),
      [`${ARCHIVE}/Work/brain-curation/2026-08-26/b.jsonl`]: transcript('b', '2026-08-26'),
      [`${ARCHIVE}/Personal/session-summarization/2026-08-26/c.jsonl`]: transcript('c', '2026-08-26'),
    });
    createCostHistoryService(db, fs).backfill([], { archiveRoot: ARCHIVE });

    expect(rows().map((r) => [r.account_name, r.internal_kind, r.project_path])).toEqual([
      ['Work', 'brain-index', 'OmniFex/Brain index'],
      ['Work', 'brain-curation', 'OmniFex/Brain curation'],
      ['Personal', 'session-summarization', 'OmniFex/Session summarization'],
    ]);
  });

  // Re-running must not double the money. This is the property the whole
  // single-accounting-path decision rests on.
  it('is idempotent', () => {
    const fs = fakeFs({
      [`${ARCHIVE}/Work/brain-index/2026-08-26/a.jsonl`]: transcript('a', '2026-08-26'),
    });
    const svc = createCostHistoryService(db, fs);
    svc.backfill([], { archiveRoot: ARCHIVE });
    svc.backfill([], { archiveRoot: ARCHIVE });
    expect(rows()).toHaveLength(1);
  });

  // A directory that is not a kind we know must not be priced under a made-up
  // label -- silently mislabelled money is worse than money we skipped.
  it('skips a directory that is not a known kind', () => {
    const fs = fakeFs({
      [`${ARCHIVE}/Work/something-else/2026-08-26/a.jsonl`]: transcript('a', '2026-08-26'),
    });
    createCostHistoryService(db, fs).backfill([], { archiveRoot: ARCHIVE });
    expect(rows()).toHaveLength(0);
  });

  it('does nothing when no archive root is given', () => {
    const fs = fakeFs({
      [`${ARCHIVE}/Work/brain-index/2026-08-26/a.jsonl`]: transcript('a', '2026-08-26'),
    });
    createCostHistoryService(db, fs).backfill([]);
    expect(rows()).toHaveLength(0);
  });

  it('leaves internal_kind NULL on an ordinary session row', () => {
    const svc = createCostHistoryService(db, fakeFs({}));
    svc.replaceSession('s1', [{
      session_id: 's1', date: '2026-08-26', model: 'claude-opus-5',
      account_name: 'Work', config_dir: '/cfg', project_path: '/Users/me/repo',
      is_subagent: 0, request_count: 1,
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
      cache_write_5m_tokens: 0, cache_write_1h_tokens: 0,
      input_usd: 0, output_usd: 0, cache_read_usd: 0, cache_write_usd: 0,
      cost_usd: 1, is_estimated: 0,
    }]);
    expect(rows()[0].internal_kind).toBeNull();
  });
});
