import { describe, expect, it } from 'vitest';
import {
  aggregateAccount,
  compareRuns,
  isInternalCwd,
  judgeSample,
  parseSearchResultPaths,
  summarizeTranscript,
  tallyVerdicts,
  type RunMetrics,
  type SessionSummary,
} from '../services/brain/value-eval';

const SEARCH = 'mcp__omnifex-brain__brain_search';
const READ = 'mcp__omnifex-brain__brain_read';
const REMEMBER = 'mcp__omnifex-brain__brain_remember';

/** Terse transcript record builders, so the tests read as a conversation. */
function prompt(text: string, ts = '2026-10-10T12:00:00.000Z', cwd = '/r/omnifex') {
  return { type: 'user', timestamp: ts, cwd, message: { role: 'user', content: text } };
}
function use(id: string, name: string, input: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    timestamp: '2026-10-10T12:01:00.000Z',
    cwd: '/r/omnifex',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  };
}
function result(id: string, text: string) {
  return {
    type: 'user',
    timestamp: '2026-10-10T12:01:01.000Z',
    cwd: '/r/omnifex',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }],
    },
  };
}
function say(text: string) {
  return {
    type: 'assistant',
    timestamp: '2026-10-10T12:02:00.000Z',
    cwd: '/r/omnifex',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

const TWO_HITS = [
  '2 notes matched "turn state".',
  '## Subsystems/sessions.md (Subsystem)\n# sessions\n\n## Summary\nbody',
  '→ brain_read "Subsystems/sessions.md" for the rest.',
  'Also matched — brain_read to open:\n- Topics/turn.md (Topic): snippet',
].join('\n\n');

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 's',
    startedAt: '2026-10-10T12:00:00.000Z',
    cwd: '/r/omnifex',
    toolUses: 30,
    wroteCode: true,
    calls: [],
    ...over,
  };
}

describe('parseSearchResultPaths', () => {
  it('reads note paths from the markdown result, full bodies then listed hits', () => {
    expect(parseSearchResultPaths([{ type: 'text', text: TWO_HITS }])).toEqual([
      'Subsystems/sessions.md',
      'Topics/turn.md',
    ]);
  });

  it('treats the no-match sentence as an empty result', () => {
    const text = 'No notes matched "x". Try fewer or different identifiers, or a related file name.';
    expect(parseSearchResultPaths([{ type: 'text', text }])).toEqual([]);
  });

  it('still reads the legacy JSON array the tool returned before markdown', () => {
    const text = JSON.stringify([{ notePath: 'A.md' }, { notePath: 'B.md' }]);
    expect(parseSearchResultPaths([{ type: 'text', text }])).toEqual(['A.md', 'B.md']);
  });

  it('accepts a plain string content', () => {
    expect(parseSearchResultPaths(TWO_HITS)).toEqual(['Subsystems/sessions.md', 'Topics/turn.md']);
  });

  it('does not mistake a heading inside a note body for a hit', () => {
    // Note bodies carry their own `## Summary` headings; only `## <path>.md (<Type>)` is a hit.
    expect(parseSearchResultPaths(TWO_HITS)).not.toContain('Summary');
  });
});

describe('isInternalCwd', () => {
  it('flags OmniFex scratch sessions however the tmpdir is spelled', () => {
    expect(isInternalCwd('/private/var/folders/x/T/omnifex-summary-scratch')).toBe(true);
    expect(isInternalCwd('/var/folders/x/T/omnifex-summary-scratch/')).toBe(true);
    expect(isInternalCwd('/Users/g/Repos/omnifex')).toBe(false);
    expect(isInternalCwd(null)).toBe(false);
  });
});

describe('summarizeTranscript', () => {
  const records = [
    prompt('why is the spinner stuck?'),
    use('t1', SEARCH, { query: 'turn state' }),
    result('t1', TWO_HITS),
    say('The note says turn lives on the session handle.'),
    use('t2', 'Read', { file_path: '/r/omnifex/x.ts' }),
    result('t2', 'file body'),
    use('t3', 'Edit', { file_path: '/r/omnifex/x.ts' }),
    use('t4', SEARCH, { query: 'nothing' }),
    result('t4', 'No notes matched "nothing". Try fewer'),
    use('t5', READ, { path: 'Subsystems/sessions.md' }),
    use('t6', REMEMBER, { note: 'x' }),
  ];

  it('takes start time and cwd from the first record that has them', () => {
    const s = summarizeTranscript(records);
    expect(s.startedAt).toBe('2026-10-10T12:00:00.000Z');
    expect(s.cwd).toBe('/r/omnifex');
  });

  it('counts every tool use and notices code edits', () => {
    const s = summarizeTranscript(records);
    expect(s.toolUses).toBe(6);
    expect(s.wroteCode).toBe(true);
  });

  it('recovers each Brain call with its ordinal among all tool uses', () => {
    const { calls } = summarizeTranscript(records);
    expect(calls.map((c) => [c.tool, c.ordinal])).toEqual([
      ['search', 0],
      ['search', 3],
      ['read', 4],
      ['remember', 5],
    ]);
    expect(calls[0]).toMatchObject({
      toolUseId: 't1',
      query: 'turn state',
      results: ['Subsystems/sessions.md', 'Topics/turn.md'],
      resultChars: TWO_HITS.length,
    });
    expect(calls[1].results).toEqual([]);
  });

  it('keeps the prompt before a search and what the model did after it, for the judge', () => {
    const [first] = summarizeTranscript(records).calls;
    expect(first.promptBefore).toBe('why is the spinner stuck?');
    expect(first.after).toContain('turn lives on the session handle');
    expect(first.after).toContain('Read');
    expect(first.after).toContain('Edit');
    expect(first.resultExcerpt).toContain('## Subsystems/sessions.md');
  });

  it('counts a tool use the CLI wrote twice only once', () => {
    // The CLI re-appends records (same ids) around compaction; a duplicated
    // search would be judged twice and inflate every per-search figure.
    const dup = [...records.slice(0, 3), ...records.slice(1, 3), ...records.slice(3)];
    const s = summarizeTranscript(dup);
    expect(s.toolUses).toBe(6);
    expect(s.calls.filter((c) => c.toolUseId === 't1')).toHaveLength(1);
    expect(s.calls.map((c) => c.ordinal)).toEqual([0, 3, 4, 5]);
  });

  it('skips unparseable shapes instead of throwing', () => {
    expect(() => summarizeTranscript([null, 42, { message: 'x' }])).not.toThrow();
    expect(summarizeTranscript([]).startedAt).toBeNull();
  });
});

describe('aggregateAccount', () => {
  const window = { since: '2026-10-01', until: '2026-10-30' };
  const call = (tool: 'search' | 'read' | 'remember', results: string[] = ['A.md'], chars = 400) => ({
    tool,
    toolUseId: Math.random().toString(),
    ordinal: 0,
    query: tool === 'search' ? 'q' : null,
    results,
    resultChars: chars,
    resultExcerpt: '',
    promptBefore: '',
    after: '',
  });

  const sessions = [
    session({ sessionId: 'a', calls: [call('search'), call('search', []), call('read')] }),
    session({ sessionId: 'b', toolUses: 5, wroteCode: false }),
    session({ sessionId: 'c', calls: [call('remember')] }),
    session({ sessionId: 'old', startedAt: '2026-09-15T12:00:00.000Z', calls: [call('search')] }),
    session({ sessionId: 'scratch', cwd: '/var/T/omnifex-summary-scratch', calls: [call('search')] }),
  ];
  const spend = [
    { date: '2026-10-05', kind: 'brain-index', usd: 20 },
    { date: '2026-10-06', kind: 'brain-curation', usd: 4 },
    { date: '2026-09-29', kind: 'brain-index', usd: 100 },
  ];
  const m = aggregateAccount({ account: 'Personal', window, sessions, spend, ledgerUsd: 23.5 });

  it('counts only human sessions that started inside the window', () => {
    expect(m.sessions.total).toBe(3);
    expect(m.sessions.withSearch).toBe(1);
    expect(m.sessions.invocationRate).toBeCloseTo(1 / 3);
  });

  it('reports invocation among substantive sessions separately', () => {
    // Trivial sessions rarely warrant a search; the headline rate hides that.
    expect(m.sessions.substantive).toBe(2);
    expect(m.sessions.substantiveInvocationRate).toBeCloseTo(1 / 2);
  });

  it('tallies calls, empty searches and the context they cost', () => {
    expect(m.calls).toMatchObject({ search: 2, read: 1, remember: 1, emptySearches: 1 });
    expect(m.calls.emptyRate).toBeCloseTo(0.5);
    expect(m.calls.searchResultTokens).toBe(200);
  });

  it('prices the window from the cost table, with the ledger alongside as a cross-check', () => {
    expect(m.spend).toMatchObject({ indexUsd: 20, curationUsd: 4, totalUsd: 24, ledgerUsd: 23.5 });
    expect(m.spend.perSearchUsd).toBe(12);
    expect(m.spend.perSearchingSessionUsd).toBe(24);
    expect(m.spend.monthlyUsd).toBeCloseTo(24);
  });

  it('leaves per-search cost null rather than dividing by zero', () => {
    const none = aggregateAccount({ account: 'W', window, sessions: [], spend, ledgerUsd: 0 });
    expect(none.spend.perSearchUsd).toBeNull();
    expect(none.sessions.invocationRate).toBeNull();
  });
});

describe('judgeSample', () => {
  const ids = Array.from({ length: 50 }, (_, i) => ({ toolUseId: `toolu_${i}` }));

  it('returns everything when under the cap', () => {
    expect(judgeSample(ids.slice(0, 5), 10)).toHaveLength(5);
  });

  it('picks the same cases on every run so reruns are comparable', () => {
    const a = judgeSample(ids, 10).map((c) => c.toolUseId);
    const b = judgeSample([...ids].reverse(), 10).map((c) => c.toolUseId);
    expect(a).toHaveLength(10);
    expect(b).toEqual(a);
  });
});

describe('tallyVerdicts', () => {
  it('counts each verdict and the share that helped', () => {
    const t = tallyVerdicts(
      [
        { caseId: '1', verdict: 'helped', value: 'continuity', evidence: 'e' },
        { caseId: '2', verdict: 'wasted', value: 'none', evidence: 'e' },
        { caseId: '3', verdict: 'helped', value: 'code-knowledge', evidence: 'e' },
        { caseId: '4', verdict: 'neutral', value: 'none', evidence: 'e' },
      ],
      { totalUsd: 40, searches: 8 },
    );
    expect(t).toMatchObject({ judged: 4, helped: 2, wasted: 1, neutral: 1, confirmed: 0, misled: 0 });
    expect(t.helpedRate).toBe(0.5);
    expect(t.byValue).toEqual({ continuity: 1, 'code-knowledge': 1, none: 2 });
    // 8 searches at a 50% help rate ≈ 4 helpful searches for $40.
    expect(t.usdPerHelpedSearch).toBe(10);
  });

  it('rejects a verdict outside the rubric', () => {
    expect(() =>
      tallyVerdicts([{ caseId: '1', verdict: 'great' as never, value: 'none', evidence: '' }], {
        totalUsd: 1,
        searches: 1,
      }),
    ).toThrow(/great/);
  });
});

describe('compareRuns', () => {
  const run = (runId: string, rate: number, usd: number): RunMetrics =>
    ({
      runId,
      window: { since: '2026-10-01', until: '2026-10-30' },
      accounts: [
        {
          account: 'Personal',
          sessions: { invocationRate: rate },
          spend: { monthlyUsd: usd },
        },
      ],
    }) as unknown as RunMetrics;

  it('lines up the same metric across runs, oldest first', () => {
    const rows = compareRuns([run('b', 0.5, 80), run('a', 0.4, 100)]);
    const rate = rows.find((r) => r.account === 'Personal' && r.metric === 'invocation rate');
    expect(rate?.values).toEqual([0.4, 0.5]);
    const usd = rows.find((r) => r.metric === 'monthly $');
    expect(usd?.values).toEqual([100, 80]);
  });
});
