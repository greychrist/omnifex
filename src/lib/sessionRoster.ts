/**
 * What the Sessions popover should show: this window's tabs, plus the live
 * sessions that have no tab here.
 *
 * The popover used to render the tab-status aggregator's list verbatim, which
 * was wrong in both directions. Summaries outlive the page that published
 * them, so a reload left phantom "working" rows that clicked into nothing.
 * And a session the daemon is genuinely running — started from another
 * window, from the iPad, or orphaned by a reload — appeared nowhere at all,
 * even though it was the one you most wanted to get back to.
 *
 * So the two sources answer different questions and are not interchangeable:
 *
 *   - The aggregator says what THIS window's tabs are doing. It is the
 *     authority there, because a subscribed client derives turn state from
 *     its own event stream.
 *   - The daemon's `session.list` says what EXISTS. Its `inFlight` and
 *     `pendingPermissions` are documented as an advisory rollup "for
 *     rendering a list, where the client has no event stream to derive
 *     from" — which is exactly and only how they are used here, for rows
 *     this window is not subscribed to.
 *
 * Pure so the rule is testable without a daemon or a renderer; the component
 * owns fetching and clicking.
 */

export interface RosterSummary {
  tabId: string;
  title: string;
  /** The CLI session GUID, or null before the session has started. */
  sessionId: string | null;
  promptStatus: 'working' | 'ready';
  [key: string]: unknown;
}

export interface RosterTab {
  id: string;
  type: string;
  order: number;
  /** The CLI session GUID this tab is bound to, if it has one yet. */
  sessionId?: string;
}

export interface RosterSession {
  sessionId: string;
  projectId: string;
  title?: string;
  agent: string;
  sessionStatus: string;
  inFlight: boolean;
  pendingPermissions: number;
  updatedAt?: string;
}

export interface RosterProject {
  projectId: string;
  path: string;
  title?: string;
}

/** A tab open in this window. Its summary is the source of truth. */
export interface AttachedRow {
  kind: 'attached';
  tabId: string;
  sessionId: string | null;
  title: string;
  promptStatus: 'working' | 'ready';
  summary: RosterSummary;
}

/** A live session with no tab here. Clicking it opens one. */
export interface DetachedRow {
  kind: 'detached';
  tabId: null;
  sessionId: string;
  title: string;
  projectPath: string | null;
  agent: string;
  promptStatus: 'working' | 'ready';
  waitingFor: 'permission' | null;
  updatedAt: string | null;
}

export type RosterRow = (AttachedRow & { projectPath?: string | null }) | DetachedRow;

export interface BuildSessionRosterInput {
  /** Everything the tab-status aggregator is currently broadcasting. */
  summaries: RosterSummary[];
  /** This window's tabs. */
  tabs: RosterTab[];
  /** The daemon's view of what exists. Empty when there is no daemon. */
  sessions: RosterSession[];
  /** Used only to turn a session's `projectId` into a path for reopening. */
  projects: RosterProject[];
}

export function buildSessionRoster({
  summaries,
  tabs,
  sessions,
  projects,
}: BuildSessionRosterInput): RosterRow[] {
  const chatTabs = tabs
    .filter((t) => t.type === 'chat')
    .sort((a, b) => a.order - b.order);

  const summaryByTabId = new Map(summaries.map((s) => [s.tabId, s]));
  const rows: RosterRow[] = [];

  // Attached: a tab in this window that has published a summary. A tab that
  // has not published yet is skipped rather than guessed at — but it still
  // claims its sessionId below, so it cannot also appear as detached.
  for (const t of chatTabs) {
    const summary = summaryByTabId.get(t.id);
    if (!summary) continue;
    rows.push({
      kind: 'attached',
      tabId: t.id,
      sessionId: summary.sessionId,
      title: summary.title,
      promptStatus: summary.promptStatus,
      summary,
    });
  }

  // Every session id this window already accounts for. Taken from the tabs
  // themselves, not from the rows above, so a tab that is still starting up
  // does not get listed a second time as "detached".
  const claimed = new Set<string>();
  for (const t of chatTabs) {
    if (t.sessionId) claimed.add(t.sessionId);
  }
  for (const row of rows) {
    if (row.sessionId) claimed.add(row.sessionId);
  }

  const pathByProjectId = new Map(projects.map((p) => [p.projectId, p]));

  const detached: DetachedRow[] = [];
  for (const s of sessions) {
    if (s.sessionStatus !== 'started') continue;
    if (claimed.has(s.sessionId)) continue;
    const project = pathByProjectId.get(s.projectId);
    detached.push({
      kind: 'detached',
      tabId: null,
      sessionId: s.sessionId,
      title: s.title ?? project?.title ?? s.sessionId,
      // Null rather than a guess: reopening needs a real path, and a wrong
      // one would start a session in the wrong directory.
      projectPath: project?.path ?? null,
      agent: s.agent,
      promptStatus: s.inFlight ? 'working' : 'ready',
      waitingFor: s.pendingPermissions > 0 ? 'permission' : null,
      updatedAt: s.updatedAt ?? null,
    });
  }

  // Newest first — a detached list is a "what did I leave running" list, and
  // the thing you left running most recently is the likeliest answer.
  detached.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

  return [...rows, ...detached];
}
