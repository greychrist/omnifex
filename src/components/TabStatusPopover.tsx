import React, { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Atom, GitBranch, FilePen, FilePlus, Activity, Bot, ListChecks, Database, Copy, Check, Unplug } from 'lucide-react';
import { api, type TabStatusSummary } from '@/lib/api';
import { useTabContext } from '@/contexts/TabContext';
import { cn } from '@/lib/utils';
import { TITLEBAR_LABEL } from '@/lib/titlebar';
import { TooltipSimple } from '@/components/ui/tooltip-modern';
import { resolveBranchColors } from '@/lib/branchColors';
import { HeaderLabel } from './HeaderLabel';
import {
  buildSessionRoster,
  type RosterSession,
  type RosterProject,
  type DetachedRow,
} from '@/lib/sessionRoster';

const STATUS_LABEL: Record<TabStatusSummary['status'], string> = {
  'not-started': 'Not started',
  starting: 'Starting…',
  idle: 'Ready',
  busy: 'Working',
  error: 'Error',
};

const STATUS_COLOR: Record<TabStatusSummary['status'], string> = {
  'not-started': 'text-muted-foreground bg-muted/40',
  starting: 'text-amber-300 bg-amber-500/15',
  idle: 'text-emerald-400 bg-emerald-500/10',
  busy: 'text-amber-300 bg-amber-500/20',
  error: 'text-red-400 bg-red-500/15',
};

const PROMPT_LABEL: Record<TabStatusSummary['promptStatus'], string> = {
  working: 'Working',
  ready: 'Ready',
};

const PROMPT_COLOR: Record<TabStatusSummary['promptStatus'], string> = {
  working: 'text-amber-300 bg-amber-500/20',
  ready: 'text-emerald-400 bg-emerald-500/10',
};

// "Waiting on the user" overrides the busy badge with a more specific
// label/color so background tabs that need you are obvious. Indigo for both
// — it's a different domain from busy (amber) and idle (green) and reads
// as "your turn" rather than "agent working".
const WAITING_LABEL: Record<NonNullable<TabStatusSummary['waitingFor']>, string> = {
  permission: 'Permission Request',
  question: 'Question Waiting',
};

const WAITING_COLOR = 'text-indigo-300 bg-indigo-500/20';

/**
 * The session GUID, copyable.
 *
 * `tabId` is a renderer-local `tab-<ts>-<rand>` that means nothing outside
 * this window; the GUID is what names the session to the daemon, to
 * `--resume`, and in the transcript path on disk. Showing it is what makes a
 * row in this list identifiable at all.
 */
const SessionIdRow: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 min-w-0 col-span-2 text-muted-foreground">
      <HeaderLabel className="inline-block w-28 shrink-0">Session:</HeaderLabel>
      <span className="font-mono text-[11px] text-foreground/80 truncate" title={sessionId}>
        {sessionId}
      </span>
      <button
        type="button"
        aria-label="Copy session id"
        className="shrink-0 p-0.5 rounded hover:bg-accent/60 transition-colors"
        onClick={(e) => {
          // The card itself is a button; copying must not also navigate.
          e.stopPropagation();
          void navigator.clipboard?.writeText(sessionId).then(() => {
            setCopied(true);
            setTimeout(() => { setCopied(false); }, 1200);
          }).catch(() => {});
        }}
      >
        {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  );
};

interface TabStatusCardProps {
  summary: TabStatusSummary;
  branchColor: string | null;
  branchIsTrunk: boolean;
  onClick: () => void;
}

const TabStatusCard: React.FC<TabStatusCardProps> = ({ summary, branchColor, branchIsTrunk, onClick }) => {
  const ctx = summary.contextUsage;
  const branchStyle =
    !branchIsTrunk && branchColor
      ? { backgroundColor: `${branchColor}33`, color: branchColor, borderColor: `${branchColor}4d` }
      : undefined;

  return (
    <div className="rounded-md border-0 bg-[color-mix(in_oklch,var(--color-background)_40%,var(--color-muted))] overflow-hidden shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent),2px_2px_4px_rgb(0_0_0/0.08)]">
      <button
        type="button"
        onClick={onClick}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 bg-muted shadow-[inset_0_-1px_0_0_color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent)] hover:bg-accent/40 transition-colors text-left app-no-drag"
      >
        <div className="flex items-center gap-2 min-w-0">
          {(() => {
            // Badge precedence:
            //  1. waitingFor (permission / question) — indigo, user action needed
            //  2. lifecycle: not-started / starting / error — use STATUS_*
            //  3. promptStatus (working / ready) — green/yellow, drives the
            //     spinner consumers too. Replaces the old `idle`/`busy` pair
            //     so the badge cleanly reflects "is the agent doing work".
            const useLifecycle =
              summary.status === 'not-started' ||
              summary.status === 'starting' ||
              summary.status === 'error';
            const color = summary.waitingFor
              ? WAITING_COLOR
              : useLifecycle
                ? STATUS_COLOR[summary.status]
                : PROMPT_COLOR[summary.promptStatus];
            const label = summary.waitingFor
              ? WAITING_LABEL[summary.waitingFor]
              : useLifecycle
                ? STATUS_LABEL[summary.status]
                : PROMPT_LABEL[summary.promptStatus];
            const pulse = !!summary.waitingFor || (!useLifecycle && summary.promptStatus === 'working');
            return (
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                  color,
                )}
              >
                {pulse && (
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                )}
                {label}
              </span>
            );
          })()}
          <span className="truncate text-sm font-medium">{summary.title}</span>
        </div>
        <span className="text-[10px] text-muted-foreground shrink-0">→</span>
      </button>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 pb-2.5 pt-1 text-xs">
        {summary.sessionId && <SessionIdRow sessionId={summary.sessionId} />}
        {summary.branch !== null && (
          <div className="flex items-center gap-2 min-w-0 col-span-2">
            <HeaderLabel className="inline-block w-28 shrink-0">Current Branch:</HeaderLabel>
            <span
              className={cn(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-mono font-medium max-w-full',
                branchIsTrunk && 'bg-black text-white border-black',
              )}
              style={branchStyle}
              title={summary.branch}
            >
              <GitBranch className="w-3 h-3 shrink-0" />
              <span className="truncate">{summary.branch}</span>
              {(summary.filesChanged > 0 || summary.filesUntracked > 0) && (
                <span aria-hidden className="h-3 w-px bg-current opacity-40 mx-0.5" />
              )}
              {summary.filesChanged > 0 && (
                <span className="inline-flex items-center gap-0.5 text-emerald-400">
                  <FilePen className="w-3 h-3" />
                  {summary.filesChanged}
                </span>
              )}
              {summary.filesUntracked > 0 && (
                <span className="inline-flex items-center gap-0.5 text-amber-300">
                  <FilePlus className="w-3 h-3" />
                  {summary.filesUntracked}
                </span>
              )}
            </span>
          </div>
        )}
        {ctx && (() => {
          const tokens = ctx.totalTokens;
          const pct = Math.min(100, ctx.percentage);
          const tokenColor = pct > 80 ? 'text-red-400' : pct > 50 ? 'text-orange-400' : 'text-foreground';
          return (
            <div className="flex items-center gap-2 col-span-2 text-muted-foreground">
              <HeaderLabel className="inline-block w-28 shrink-0">Context Size:</HeaderLabel>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono font-medium text-foreground',
                  'bg-background shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent)]',
                )}
              >
                <Database className="w-3.5 h-3.5 text-foreground" />
                <span className={cn('font-mono', tokenColor)}>
                  {tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens}
                </span>
                <div className="w-24 h-1.5 bg-foreground/10 rounded-full overflow-hidden relative">
                  <div
                    className="absolute inset-0 rounded-full bg-gradient-to-r from-green-400 via-orange-400 to-red-400 transition-[clip-path]"
                    style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}
                  />
                </div>
                <span className="text-foreground font-mono">{pct.toFixed(0)}%</span>
              </span>
            </div>
          );
        })()}
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Activity size={11} />
          <span className="text-foreground">
            {summary.mainTurnInFlight ? 'Turn in flight' : 'No turn'}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Bot size={11} />
          <span className="text-foreground">
            {summary.activeAgents > 0
              ? `${summary.activeAgents} agent${summary.activeAgents === 1 ? '' : 's'}`
              : 'No agents'}
          </span>
        </div>
        {summary.tasks.total > 0 && (
          <div className="flex items-center gap-1.5 col-span-2 text-muted-foreground">
            <ListChecks size={11} />
            <span className="text-foreground">
              {summary.tasks.completed} of {summary.tasks.total} tasks
              {summary.tasks.inFlight && (
                <span className="text-muted-foreground"> · {summary.tasks.total - summary.tasks.completed} pending</span>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * A session the daemon is running that has no tab in this window.
 *
 * Deliberately sparser than an attached card: everything here comes from
 * `session.list`'s advisory rollup, which the protocol documents as being
 * for exactly this case — a list the client has no event stream for. There
 * is no branch, context size or agent count to show honestly, so none is
 * shown rather than showing a stale one.
 */
const DetachedSessionCard: React.FC<{ row: DetachedRow; onClick: () => void }> = ({ row, onClick }) => {
  // Reattaching needs a real directory. Without one the tab would open on
  // nothing, so the row stays visible — the session IS running and you may
  // want its id — but is not clickable, and says why.
  const canOpen = row.projectPath !== null;
  return (
  <div className="rounded-md border-0 bg-[color-mix(in_oklch,var(--color-background)_40%,var(--color-muted))] overflow-hidden shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_25%,transparent),2px_2px_4px_rgb(0_0_0/0.08)]">
    <button
      type="button"
      onClick={onClick}
      disabled={!canOpen}
      title={row.projectPath ?? 'No project on record for this session — cannot reopen it here'}
      className={cn(
        'w-full flex items-center justify-between gap-3 px-3 py-2 bg-muted/60 shadow-[inset_0_-1px_0_0_color-mix(in_oklch,var(--color-muted-foreground)_25%,transparent)] transition-colors text-left app-no-drag',
        canOpen ? 'hover:bg-accent/40' : 'cursor-not-allowed opacity-70',
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
            row.waitingFor ? WAITING_COLOR : row.promptStatus === 'working' ? PROMPT_COLOR.working : 'text-sky-300 bg-sky-500/15',
          )}
        >
          {(row.waitingFor || row.promptStatus === 'working') && (
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
          )}
          {row.waitingFor ? WAITING_LABEL.permission : row.promptStatus === 'working' ? 'Working' : 'Detached'}
        </span>
        <span className="truncate text-sm font-medium">{row.title}</span>
      </div>
      <span className="text-[10px] text-muted-foreground shrink-0 inline-flex items-center gap-1">
        <Unplug className="w-3 h-3" />
        {canOpen ? 'Open' : 'No path'}
      </span>
    </button>
    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 pb-2.5 pt-1 text-xs">
      <SessionIdRow sessionId={row.sessionId} />
      {row.projectPath && (
        <div className="flex items-center gap-2 min-w-0 col-span-2 text-muted-foreground">
          <HeaderLabel className="inline-block w-28 shrink-0">Project:</HeaderLabel>
          <span className="font-mono text-[11px] text-foreground/70 truncate" title={row.projectPath}>
            {row.projectPath}
          </span>
        </div>
      )}
    </div>
  </div>
  );
};

export const TabStatusPopover: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [summaries, setSummaries] = useState<TabStatusSummary[]>([]);
  const [sessions, setSessions] = useState<RosterSession[]>([]);
  const [projects, setProjects] = useState<RosterProject[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { tabs, setActiveTab, addTab } = useTabContext();

  // Subscribe to live updates whenever the popover is mounted (always-on, so
  // the badge dot can update even when closed).
  useEffect(() => {
    let cancelled = false;
    void api.listTabStatuses().then((list) => {
      if (!cancelled) setSummaries(list);
    });
    const off = api.onTabStatusesChanged((list) => { setSummaries(list); });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // What the daemon is running. Polled only while the popover is open —
  // this is a "what did I leave going" list, not a live feed, and the
  // attached rows already have their own event stream. In desktop-only mode
  // there is no client, so the list stays empty and only tabs are shown.
  useEffect(() => {
    if (!open) return;
    const client = window.__omnifexRemote?.client;
    if (!client) return;
    let cancelled = false;
    const load = async () => {
      try {
        const [s, p] = await Promise.all([
          client.request('session.list', {}),
          client.request('project.list', {}),
        ]);
        if (cancelled) return;
        setSessions(s as unknown as RosterSession[]);
        setProjects(p as unknown as RosterProject[]);
      } catch {
        // A daemon that cannot be reached means no detached rows, not a
        // broken popover — the tabs in this window still render.
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 4000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [open]);

  // Click-outside / Escape to close
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (
        triggerRef.current &&
        contentRef.current &&
        !triggerRef.current.contains(e.target as Node) &&
        !contentRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // This window's tabs, then the live sessions that have no tab here.
  //
  // The aggregator's list is NOT rendered verbatim any more. Summaries
  // outlive the page that published them, so a reload used to leave phantom
  // rows that clicked into nothing — they were appended here "(defensively)"
  // under a comment claiming they were dropped. `buildSessionRoster` drops
  // them and lets the daemon re-add whatever is genuinely still running.
  const roster = buildSessionRoster({
    summaries: summaries as unknown as Parameters<typeof buildSessionRoster>[0]['summaries'],
    tabs,
    sessions,
    projects,
  });

  // Working count drives the tooltip "N working of M" — uses the same
  // promptStatus signal as the per-tab badge and the upgrade gate.
  const busyCount = roster.filter((r) => r.promptStatus === 'working').length;

  const branchResolution = resolveBranchColors({
    pins: {},
    mainFolderBranch: null,
    branches: roster
      .map((r) => (r.kind === 'attached' ? (r.summary as unknown as TabStatusSummary).branch : null))
      .filter((b): b is string => b != null),
  });

  /** Focus the tab that already shows this session, or open one for it. */
  const openDetached = (row: DetachedRow) => {
    if (row.projectPath === null) return;
    const existing = tabs.find((t) => t.type === 'chat' && t.sessionId === row.sessionId);
    if (existing) {
      setActiveTab(existing.id);
      setOpen(false);
      return;
    }
    addTab({
      type: 'chat',
      title: row.title,
      agent: (row.agent as 'claude' | 'codex') ?? 'claude',
      sessionId: row.sessionId,
      // What the session needs to reattach. Guaranteed non-null by the
      // guard above and by the card being disabled without it.
      initialProjectPath: row.projectPath,
      status: 'idle',
      hasUnsavedChanges: false,
      icon: 'message-square',
    });
    setOpen(false);
  };

  return (
    <div className="relative inline-block">
      <TooltipSimple
        content={busyCount > 0 ? `${busyCount} working of ${roster.length}` : 'Sessions'}
        side="bottom"
      >
        <button
          ref={triggerRef}
          type="button"
          onClick={() => { setOpen((v) => !v); }}
          aria-label="Sessions"
          data-testid="sessions-trigger"
          className={cn(
            'relative inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-colors app-no-drag',
            open && 'bg-accent text-accent-foreground',
          )}
        >
          <Atom size={16} />
          <span className={TITLEBAR_LABEL}>Sessions</span>
          {busyCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[14px] h-[14px] px-1 rounded-full bg-amber-500 text-[9px] font-bold text-amber-950">
              {busyCount}
            </span>
          )}
        </button>
      </TooltipSimple>

      <AnimatePresence>
        {open && (
          <div
            ref={contentRef}
            className="absolute z-50 right-0 top-full mt-2"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: -8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -8 }}
              transition={{ duration: 0.12 }}
              className="w-[420px] max-h-[70vh] overflow-y-auto rounded-md border border-border bg-background text-popover-foreground shadow-lg"
            >
              <div className="px-3 py-2 border-b border-border bg-popover flex items-center justify-between">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Tab Status
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {roster.length} session{roster.length === 1 ? '' : 's'}
                  {busyCount > 0 && ` · ${busyCount} busy`}
                </div>
              </div>

              {roster.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No chat tabs open.
                </div>
              ) : (
                <div className="p-2 space-y-1.5">
                  {roster.map((row) => {
                    if (row.kind === 'detached') {
                      return (
                        <DetachedSessionCard
                          key={row.sessionId}
                          row={row}
                          onClick={() => { openDetached(row); }}
                        />
                      );
                    }
                    const s = row.summary as unknown as TabStatusSummary;
                    return (
                      <TabStatusCard
                        key={row.tabId}
                        summary={s}
                        branchColor={s.branch ? branchResolution.colors[s.branch] ?? null : null}
                        branchIsTrunk={s.branch ? branchResolution.trunkBlack.has(s.branch) : false}
                        onClick={() => {
                          setActiveTab(row.tabId);
                          setOpen(false);
                        }}
                      />
                    );
                  })}
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
