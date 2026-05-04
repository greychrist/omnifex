import React, { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Atom, GitBranch, FileText, Activity, Bot, ListChecks } from 'lucide-react';
import { api, type TabStatusSummary } from '@/lib/api';
import { useTabContext } from '@/contexts/TabContext';
import { cn } from '@/lib/utils';
import { TooltipSimple } from '@/components/ui/tooltip-modern';

const STATUS_LABEL: Record<TabStatusSummary['status'], string> = {
  'not-started': 'Not started',
  starting: 'Starting…',
  idle: 'Idle',
  busy: 'Busy',
  error: 'Error',
};

const STATUS_COLOR: Record<TabStatusSummary['status'], string> = {
  'not-started': 'text-muted-foreground bg-muted/40',
  starting: 'text-amber-300 bg-amber-500/15',
  idle: 'text-emerald-400 bg-emerald-500/10',
  busy: 'text-amber-300 bg-amber-500/20',
  error: 'text-red-400 bg-red-500/15',
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface TabStatusCardProps {
  summary: TabStatusSummary;
  onClick: () => void;
}

const TabStatusCard: React.FC<TabStatusCardProps> = ({ summary, onClick }) => {
  const ctx = summary.contextUsage;
  const ctxPct = ctx ? Math.round(ctx.percentage) : null;

  return (
    <div className="rounded-md border border-border bg-card/40 overflow-hidden">
      <button
        type="button"
        onClick={onClick}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 hover:bg-accent/40 transition-colors text-left app-no-drag"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
              STATUS_COLOR[summary.status],
            )}
          >
            {summary.status === 'busy' && (
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
            )}
            {STATUS_LABEL[summary.status]}
          </span>
          <span className="truncate text-sm font-medium">{summary.title}</span>
        </div>
        <span className="text-[10px] text-muted-foreground shrink-0">→</span>
      </button>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 pb-2.5 pt-1 text-xs">
        {summary.branch !== null && (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <GitBranch size={11} />
            <span className="truncate font-mono text-foreground">{summary.branch}</span>
          </div>
        )}
        {summary.branch !== null && (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <FileText size={11} />
            <span className="text-foreground">
              {summary.filesChanged} changed
              {summary.filesUntracked > 0 && (
                <span className="text-muted-foreground">
                  {' '}· {summary.filesUntracked} untracked
                </span>
              )}
            </span>
          </div>
        )}
        {ctx && (
          <div className="flex items-center gap-1.5 col-span-2 text-muted-foreground">
            <span className="w-3 inline-flex justify-center">{ctxPct}%</span>
            <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full',
                  ctxPct! >= 90 ? 'bg-red-500' : ctxPct! >= 70 ? 'bg-amber-500' : 'bg-primary',
                )}
                style={{ width: `${Math.min(100, ctxPct!)}%` }}
              />
            </div>
            <span className="text-foreground tabular-nums">
              {formatTokens(ctx.totalTokens)} / {formatTokens(ctx.maxTokens)}
            </span>
          </div>
        )}
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
        {summary.todos.total > 0 && (
          <div className="flex items-center gap-1.5 col-span-2 text-muted-foreground">
            <ListChecks size={11} />
            <span className="text-foreground">
              {summary.todos.completed} of {summary.todos.total} todos
              {summary.todos.inFlight && (
                <span className="text-muted-foreground"> · {summary.todos.total - summary.todos.completed} pending</span>
              )}
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { tabs, setActiveTab } = useTabContext();

  // Subscribe to live updates whenever the popover is mounted (always-on, so
  // the badge dot can update even when closed).
  useEffect(() => {
    let cancelled = false;
    void api.listTabStatuses().then((list) => {
      if (!cancelled) setSummaries(list);
    });
    const off = api.onTabStatusesChanged((list) => setSummaries(list));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

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

  // Sort by tab-bar order, then drop summaries for closed tabs.
  const tabOrder = tabs
    .filter((t) => t.type === 'chat')
    .sort((a, b) => a.order - b.order)
    .map((t) => t.id);
  const tabIdSet = new Set(tabOrder);
  const ordered: TabStatusSummary[] = [];
  for (const tabId of tabOrder) {
    const s = summaries.find((x) => x.tabId === tabId);
    if (s) ordered.push(s);
  }
  // Include any unknown ids at the end (defensive)
  for (const s of summaries) {
    if (!tabIdSet.has(s.tabId)) ordered.push(s);
  }

  const busyCount = ordered.filter((s) => s.busy).length;

  return (
    <div className="relative inline-block">
      <TooltipSimple
        content={busyCount > 0 ? `${busyCount} busy of ${ordered.length}` : 'Tab status'}
        side="bottom"
      >
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label="Sessions"
          className={cn(
            'relative inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-colors app-no-drag',
            open && 'bg-accent text-accent-foreground',
          )}
        >
          <Atom size={16} />
          <span>Sessions</span>
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
              className="w-[420px] max-h-[70vh] overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
            >
              <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Tab Status
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {ordered.length} tab{ordered.length === 1 ? '' : 's'}
                  {busyCount > 0 && ` · ${busyCount} busy`}
                </div>
              </div>

              {ordered.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No chat tabs open.
                </div>
              ) : (
                <div className="p-2 space-y-1.5">
                  {ordered.map((s) => (
                    <TabStatusCard
                      key={s.tabId}
                      summary={s}
                      onClick={() => {
                        setActiveTab(s.tabId);
                        setOpen(false);
                      }}
                    />
                  ))}
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
