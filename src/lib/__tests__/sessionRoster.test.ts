import { describe, it, expect } from 'vitest';
import { buildSessionRoster, type RosterSummary, type RosterTab, type RosterSession, type RosterProject } from '../sessionRoster';

function summary(tabId: string, over: Partial<RosterSummary> = {}): RosterSummary {
  return {
    tabId,
    title: tabId,
    sessionId: `sess-${tabId}`,
    promptStatus: 'ready',
    ...over,
  } as RosterSummary;
}

function tab(id: string, order: number, sessionId?: string): RosterTab {
  return { id, type: 'chat', order, sessionId: sessionId ?? `sess-${id}` };
}

function session(sessionId: string, over: Partial<RosterSession> = {}): RosterSession {
  return {
    sessionId,
    projectId: 'proj-1',
    agent: 'claude',
    sessionStatus: 'started',
    inFlight: false,
    pendingPermissions: 0,
    ...over,
  } as RosterSession;
}

const projects: RosterProject[] = [
  { projectId: 'proj-1', path: '/Users/g/Repos/WIN', title: 'WIN' },
];

describe('buildSessionRoster — attached rows', () => {
  it('lists this window\'s chat tabs in tab-bar order', () => {
    const roster = buildSessionRoster({
      summaries: [summary('t2'), summary('t1')],
      tabs: [tab('t1', 0), tab('t2', 1)],
      sessions: [],
      projects,
    });
    expect(roster.map((r) => [r.kind, r.sessionId])).toEqual([
      ['attached', 'sess-t1'],
      ['attached', 'sess-t2'],
    ]);
  });

  it('skips a tab that has not published a summary yet', () => {
    const roster = buildSessionRoster({
      summaries: [summary('t1')],
      tabs: [tab('t1', 0), tab('t2', 1)],
      sessions: [],
      projects,
    });
    expect(roster).toHaveLength(1);
  });

  it('ignores non-chat tabs', () => {
    const roster = buildSessionRoster({
      summaries: [summary('t1')],
      tabs: [{ id: 't1', type: 'projects', order: 0 }],
      sessions: [],
      projects,
    });
    expect(roster).toEqual([]);
  });
});

describe('buildSessionRoster — stale summaries', () => {
  it('drops a summary whose tab no longer exists', () => {
    // The ghost case: a reload left summaries behind in the aggregator. They
    // are not sessions this window can speak for, so they are never rendered
    // as attached rows. If the session is genuinely alive the daemon list
    // below re-adds it as detached.
    const roster = buildSessionRoster({
      summaries: [summary('t1'), summary('gone')],
      tabs: [tab('t1', 0)],
      sessions: [],
      projects,
    });
    expect(roster.map((r) => r.sessionId)).toEqual(['sess-t1']);
  });

  it('does not resurrect a stale summary whose session the daemon no longer has', () => {
    const roster = buildSessionRoster({
      summaries: [summary('gone')],
      tabs: [],
      sessions: [],
      projects,
    });
    expect(roster).toEqual([]);
  });
});

describe('buildSessionRoster — detached rows', () => {
  it('lists a live daemon session that has no tab in this window', () => {
    const roster = buildSessionRoster({
      summaries: [],
      tabs: [],
      sessions: [session('sess-win', { title: 'WIN', inFlight: true })],
      projects,
    });
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({
      kind: 'detached',
      sessionId: 'sess-win',
      title: 'WIN',
      projectPath: '/Users/g/Repos/WIN',
      promptStatus: 'working',
    });
  });

  it('does not duplicate a session that is already open in a tab', () => {
    const roster = buildSessionRoster({
      summaries: [summary('t1')],
      tabs: [tab('t1', 0, 'sess-t1')],
      sessions: [session('sess-t1')],
      projects,
    });
    expect(roster).toHaveLength(1);
    expect(roster[0].kind).toBe('attached');
  });

  it('excludes a session the tab owns even when that tab has not published yet', () => {
    // Otherwise a tab still starting up shows up twice: once as its own
    // pending row and once as "detached".
    const roster = buildSessionRoster({
      summaries: [],
      tabs: [tab('t1', 0, 'sess-t1')],
      sessions: [session('sess-t1')],
      projects,
    });
    expect(roster).toEqual([]);
  });

  it('ignores sessions the daemon reports as stopped', () => {
    const roster = buildSessionRoster({
      summaries: [],
      tabs: [],
      sessions: [session('a', { sessionStatus: 'stopped' }), session('b')],
      projects,
    });
    expect(roster.map((r) => r.sessionId)).toEqual(['b']);
  });

  it('falls back to the project title, then the session id, for a name', () => {
    const roster = buildSessionRoster({
      summaries: [],
      tabs: [],
      sessions: [session('sess-a'), session('sess-b', { projectId: 'unknown' })],
      projects,
    });
    expect(roster.map((r) => r.title)).toEqual(['WIN', 'sess-b']);
  });

  it('leaves projectPath null when the project is unknown, rather than guessing', () => {
    const roster = buildSessionRoster({
      summaries: [],
      tabs: [],
      sessions: [session('sess-b', { projectId: 'unknown' })],
      projects,
    });
    expect(roster[0].projectPath).toBeNull();
  });

  it('sorts detached rows newest-updated first', () => {
    const roster = buildSessionRoster({
      summaries: [],
      tabs: [],
      sessions: [
        session('old', { updatedAt: '2026-09-14T10:00:00Z' }),
        session('new', { updatedAt: '2026-09-14T12:00:00Z' }),
        session('mid', { updatedAt: '2026-09-14T11:00:00Z' }),
      ],
      projects,
    });
    expect(roster.map((r) => r.sessionId)).toEqual(['new', 'mid', 'old']);
  });

  it('puts attached rows before detached ones', () => {
    const roster = buildSessionRoster({
      summaries: [summary('t1')],
      tabs: [tab('t1', 0, 'sess-t1')],
      sessions: [session('sess-other')],
      projects,
    });
    expect(roster.map((r) => r.kind)).toEqual(['attached', 'detached']);
  });

  it('reports a detached session waiting on a permission as needing the user', () => {
    const roster = buildSessionRoster({
      summaries: [],
      tabs: [],
      sessions: [session('a', { pendingPermissions: 1 })],
      projects,
    });
    expect(roster[0]).toMatchObject({ waitingFor: 'permission', promptStatus: 'ready' });
  });

  it('survives a daemon that is unreachable — no sessions, no crash', () => {
    const roster = buildSessionRoster({
      summaries: [summary('t1')],
      tabs: [tab('t1', 0)],
      sessions: [],
      projects: [],
    });
    expect(roster.map((r) => r.kind)).toEqual(['attached']);
  });
});

describe('buildSessionRoster — counts', () => {
  it('a detached in-flight session counts as working', () => {
    const roster = buildSessionRoster({
      summaries: [summary('t1', { promptStatus: 'working' })],
      tabs: [tab('t1', 0)],
      sessions: [session('other', { inFlight: true })],
      projects,
    });
    expect(roster.filter((r) => r.promptStatus === 'working')).toHaveLength(2);
  });
});
