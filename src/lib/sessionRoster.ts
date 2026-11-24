// This window's tab summaries are authoritative for its tabs; session.list's inFlight/pendingPermissions
// are an advisory rollup, used only for sessions this window is not subscribed to.

export interface RosterSummary {
  tabId: string;
  title: string;
  sessionId: string | null;
  promptStatus: 'working' | 'ready';
  [key: string]: unknown;
}

export interface RosterTab {
  id: string;
  type: string;
  order: number;
  sessionId?: string;
}

export type OpenIn = 'here' | 'app' | 'browser';

export interface RosterSession {
  sessionId: string;
  projectId: string;
  title?: string;
  agent: string;
  sessionStatus: string;
  inFlight: boolean;
  pendingPermissions: number;
  updatedAt?: string;
  openIn?: ('desktop' | 'web')[];
}

export interface RosterProject {
  projectId: string;
  path: string;
  title?: string;
}

export interface AttachedRow {
  kind: 'attached';
  tabId: string;
  sessionId: string | null;
  title: string;
  promptStatus: 'working' | 'ready';
  summary: RosterSummary;
  openIn: ['here'];
}

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
  openIn: Exclude<OpenIn, 'here'>[];
}

export type RosterRow = (AttachedRow & { projectPath?: string | null }) | DetachedRow;

export interface BuildSessionRosterInput {
  summaries: RosterSummary[];
  tabs: RosterTab[];
  sessions: RosterSession[];
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

  // A tab yet to publish is skipped, but still claims its sessionId below.
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
      openIn: ['here'],
    });
  }

  // Claimed from the tabs, not the rows, so a starting tab isn't also listed as detached.
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
      // Null rather than a guess: a wrong path starts a session in the wrong directory.
      projectPath: project?.path ?? null,
      agent: s.agent,
      promptStatus: s.inFlight ? 'working' : 'ready',
      waitingFor: s.pendingPermissions > 0 ? 'permission' : null,
      updatedAt: s.updatedAt ?? null,
      openIn: (s.openIn ?? []).map((kind) => (kind === 'desktop' ? 'app' : 'browser')),
    });
  }

  detached.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

  return [...rows, ...detached];
}
