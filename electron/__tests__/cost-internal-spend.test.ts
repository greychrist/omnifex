import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createCostHistoryService, type CostFs } from '../services/cost/cost-history';

/**
 * OmniFex's own CLI runs (summaries, Brain) are priced the moment they finish
 * and their transcripts are deleted — only the spend is kept. The transcript is
 * ordinary CLI JSONL, so it goes through the same parser and the same rates;
 * what differs is attribution: the project path is a display label for the
 * activity, never the scratch cwd the CLI ran in.
 */

/** One deduped assistant record: 1M output tokens of Sonnet 5 = $10.00. */
function transcript(sessionId: string, date: string): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: `req-${sessionId}`,
    timestamp: `${date}T12:00:00.000Z`,
    sessionId,
    cwd: '/private/var/folders/x/T/omnifex-summary-scratch',
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

describe('internal spend in the cost table', () => {
  let db: Database;

  beforeEach(() => { db = createDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  function rows() {
    return db.raw
      .prepare('SELECT session_id, account_name, project_path, internal_kind, model, cost_usd FROM session_cost_daily ORDER BY session_id')
      .all() as Array<Record<string, unknown>>;
  }

  it('prices an internal run and says which activity paid for it', () => {
    const svc = createCostHistoryService(db, fakeFs({}));
    svc.recordInternal({
      sessionId: 'abc', content: transcript('abc', '2026-08-26'),
      kind: 'brain-index', accountName: 'Work', configDir: '/cfg/work',
    });

    expect(rows()).toEqual([{
      session_id: 'abc',
      account_name: 'Work',
      project_path: 'OmniFex/Brain index',
      internal_kind: 'brain-index',
      model: 'claude-sonnet-5',
      cost_usd: 10,
    }]);
  });

  // The 2,500 transcripts stranded between June and October were already
  // priced under the scratch path. Recording them replaces those rows by
  // session id; it must not add a second copy.
  it('replaces rows an earlier pass wrote under the scratch path', () => {
    const scratch = '/cfg/work/projects/-private-var-folders-x-T-omnifex-summary-scratch';
    const svc = createCostHistoryService(db, fakeFs({}));
    svc.replaceSession('abc', [{
      session_id: 'abc', date: '2026-08-26', model: 'claude-sonnet-5', account_name: 'Work',
      config_dir: '/cfg/work', project_path: scratch, is_subagent: 0, request_count: 1,
      input_tokens: 0, output_tokens: 1_000_000, cache_read_tokens: 0,
      cache_write_5m_tokens: 0, cache_write_1h_tokens: 0,
      input_usd: 0, output_usd: 10, cache_read_usd: 0, cache_write_usd: 0,
      cost_usd: 10, is_estimated: 0,
    }]);

    svc.recordInternal({
      sessionId: 'abc', content: transcript('abc', '2026-08-26'),
      kind: 'session-summarization', accountName: 'Work', configDir: '/cfg/work',
    });

    expect(rows()).toEqual([expect.objectContaining({
      session_id: 'abc', project_path: 'OmniFex/Session summarization', cost_usd: 10,
    })]);
  });

  // The runner prices and deletes its own transcript. If the sweep priced it
  // too while it existed, it would land under the scratch path — the
  // mislabelling this replaces.
  it('never prices the scratch dir in the projects walk', () => {
    const svc = createCostHistoryService(db, fakeFs({
      '/cfg/work/projects/-private-var-folders-x-T-omnifex-summary-scratch/abc.jsonl': transcript('abc', '2026-08-26'),
      '/cfg/work/projects/-Users-me-repo/real.jsonl': transcript('real', '2026-08-26'),
    }));
    svc.backfill([{ name: 'Work', config_dir: '/cfg/work' }]);

    expect(rows().map((r) => r.session_id)).toEqual(['real']);
  });

  it('leaves internal_kind NULL on an ordinary session row', () => {
    const svc = createCostHistoryService(db, fakeFs({
      '/cfg/work/projects/-Users-me-repo/real.jsonl': transcript('real', '2026-08-26'),
    }));
    svc.backfill([{ name: 'Work', config_dir: '/cfg/work' }]);
    expect(rows()[0].internal_kind).toBeNull();
  });
});
