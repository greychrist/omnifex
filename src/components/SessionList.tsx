import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Copy, Check, RefreshCw, Hash, ChevronDown, ChevronUp } from "lucide-react";
import { Pagination } from "@/components/ui/pagination";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { truncateText, getFirstLine } from "@/lib/date-utils";
import { api, type Session, type SessionSummary } from "@/lib/api";

interface SessionListProps {
  /**
   * Array of sessions to display
   */
  sessions: Session[];
  /**
   * The current project path being viewed
   */
  projectPath: string;
  /**
   * Optional callback to go back to project list (deprecated - use tabs instead)
   */
  onBack?: () => void;
  /**
   * Callback when a session is clicked
   */
  onSessionClick?: (session: Session) => void;
  /**
   * Callback to re-fetch the session list (refresh button). When provided,
   * the component renders a small refresh icon in the header row. The
   * component manages its own pending/spinner state while the promise is
   * in flight; callers don't need to pass any loading flag.
   */
  onRefresh?: () => Promise<void> | void;
  /**
   * Callback to open the "Open session by GUID" dialog. When provided,
   * a small `Open by ID…` button is rendered in the header row next to
   * the session count. The dialog itself is owned by the caller.
   */
  onOpenById?: () => void;
  /**
   * Optional className for styling
   */
  className?: string;
}

const ITEMS_PER_PAGE = 12;

/**
 * SessionList component - Displays paginated sessions for a specific project
 *
 * @example
 * <SessionList
 *   sessions={sessions}
 *   projectPath="/Users/example/project"
 *   onBack={() => setSelectedProject(null)}
 *   onSessionClick={(session) => console.log('Selected session:', session)}
 * />
 */
export const SessionList: React.FC<SessionListProps> = ({
  sessions,
  projectPath,
  onSessionClick,
  onRefresh,
  onOpenById,
  className,
}) => {
  const [currentPage, setCurrentPage] = useState(1);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefreshClick = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };
  /** Most recently copied session ID — drives the "Copied" affordance on the
   *  copy button. Cleared after a short delay so the icon flips back. */
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopySessionId = (id: string) => {
    void navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => {
      setCopiedId((prev) => (prev === id ? null : prev));
    }, 1500);
  };

  // ── Per-session summaries ────────────────────────────────────────────
  // Map keyed by session.id. `null` = no summary on disk (fall back to
  // first_message); `undefined` = not yet fetched.
  const [summaries, setSummaries] = useState<Map<string, SessionSummary | null>>(
    new Map(),
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [summaryRefreshing, setSummaryRefreshing] = useState<Set<string>>(
    new Set(),
  );
  // Per-row error message for the most recent failed manual refresh.
  // Auto-clears after a few seconds. No toast library is wired in this
  // codebase, so we surface failures inline.
  const [summaryErrors, setSummaryErrors] = useState<Map<string, string>>(
    new Map(),
  );

  // Fetch summaries in parallel whenever the session list or project path
  // changes. The IPC layer answers each call independently; we don't await
  // them serially.
  useEffect(() => {
    if (!sessions.length || !projectPath) return;
    let cancelled = false;
    Promise.all(
      sessions.map(async (s) => {
        const summary = await api
          .summaryGet(s.id, projectPath)
          .catch(() => null);
        return [s.id, summary] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setSummaries(new Map(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [sessions, projectPath]);

  // Subscribe to backend summary-updated events so auto-on-close
  // generations refresh the matching row in real time. We re-fetch the
  // sidecar via the same `summaryGet` path so the row source-of-truth
  // stays consistent with the disk.
  useEffect(() => {
    if (!projectPath) return;
    const unsubscribe = api.onSessionSummaryUpdated(({ sessionUuid }) => {
      api
        .summaryGet(sessionUuid, projectPath)
        .then((summary) => {
          setSummaries((prev) => new Map(prev).set(sessionUuid, summary));
        })
        .catch(() => {
          // Silent — the row keeps its previous state.
        });
    });
    return () => {
      unsubscribe?.();
    };
  }, [projectPath]);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const refreshSummary = useCallback(
    async (id: string) => {
      if (summaryRefreshing.has(id) || !projectPath) return;
      setSummaryRefreshing((prev) => new Set(prev).add(id));
      // Clear any previous error on this row before retrying.
      setSummaryErrors((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      try {
        const fresh = await api.summaryGenerate(id, projectPath);
        if (fresh) {
          setSummaries((prev) => new Map(prev).set(id, fresh));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Summary failed.';
        console.error('[SessionList] summaryGenerate failed:', err);
        setSummaryErrors((prev) => new Map(prev).set(id, message));
        // Auto-clear after 6s so the row doesn't accumulate stale errors.
        setTimeout(() => {
          setSummaryErrors((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Map(prev);
            next.delete(id);
            return next;
          });
        }, 6000);
      } finally {
        setSummaryRefreshing((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [projectPath, summaryRefreshing],
  );

  // Calculate pagination
  const totalPages = Math.ceil(sessions.length / ITEMS_PER_PAGE);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const currentSessions = sessions.slice(startIndex, endIndex);

  // Reset to page 1 if sessions change
  React.useEffect(() => {
    setCurrentPage(1);
  }, [sessions.length]);

  return (
    <TooltipProvider>
      <div className={cn("space-y-4", className)}>
      {/* Header row: session count + Open-by-ID + refresh. Renders only
          when at least one of those affordances is present so empty
          states stay clean. */}
      {(onRefresh || onOpenById || sessions.length > 0) && (
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {sessions.length} session{sessions.length !== 1 ? 's' : ''}
          </span>
          {onOpenById && (
            <button
              type="button"
              onClick={onOpenById}
              className={cn(
                "inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border/60 text-xs",
                "text-muted-foreground hover:text-foreground hover:bg-accent transition-colors",
              )}
              title="Open a session by pasting its GUID"
            >
              <Hash className="h-3 w-3" />
              Open a Session by UUID
            </button>
          )}
          {onRefresh && (
            <button
              type="button"
              onClick={() => void handleRefreshClick()}
              disabled={refreshing}
              className={cn(
                "ml-auto inline-flex items-center justify-center h-8 w-8 rounded-md border border-border/60",
                "text-muted-foreground hover:text-foreground hover:bg-accent transition-colors",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
              title={refreshing ? 'Refreshing…' : 'Refresh session list'}
              aria-label="Refresh session list"
            >
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            </button>
          )}
        </div>
      )}


      <AnimatePresence mode="popLayout">
        <div className="rounded-md border border-border/40 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left font-medium py-2 px-3 w-36">Date</th>
                <th className="text-left font-medium py-2 px-3">Summary</th>
                <th className="text-left font-medium py-2 px-3 w-28">Session ID</th>
                <th className="text-left font-medium py-2 px-3 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {currentSessions.map((session, index) => {
                const fmt = (d: Date) =>
                  `${d.toLocaleDateString('en-US', {
                    month: 'numeric',
                    day: 'numeric',
                    year: 'numeric',
                  })} ${d.toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}`;
                const firstDate = session.first_timestamp
                  ? new Date(session.first_timestamp)
                  : null;
                const lastDate = session.last_timestamp
                  ? new Date(session.last_timestamp)
                  : new Date(session.created_at * 1000);
                const summary = summaries.get(session.id);
                const isExpanded = expanded.has(session.id);
                const isRefreshing = summaryRefreshing.has(session.id);
                // Refresh button is a no-op when the JSONL size hasn't
                // changed since the last successful summary — the
                // backend size-gate would skip the API call anyway, so
                // we surface that state in the UI instead of letting the
                // button look clickable.
                const noChanges =
                  !!summary &&
                  typeof session.file_size_bytes === 'number' &&
                  session.file_size_bytes === summary.jsonlSize;
                return (
                  <motion.tr
                    key={session.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{
                      duration: 0.2,
                      delay: index * 0.02,
                      ease: [0.4, 0, 0.2, 1],
                    }}
                    className={cn(
                      "border-t border-border/30 hover:bg-accent/40 cursor-pointer transition-colors",
                      session.todo_data && "bg-primary/5",
                    )}
                    onClick={() => {
                      const event = new CustomEvent('claude-session-selected', {
                        detail: { session, projectPath },
                      });
                      window.dispatchEvent(event);
                      onSessionClick?.(session);
                    }}
                  >
                    <td className="py-2 px-3 text-[11px] text-muted-foreground whitespace-nowrap leading-tight align-top">
                      {firstDate && (
                        <div>{fmt(firstDate)}</div>
                      )}
                      <div className={firstDate ? 'text-muted-foreground/70' : ''}>
                        {fmt(lastDate)}
                      </div>
                    </td>
                    <td className="py-2 px-3 text-xs text-foreground/90 max-w-0 align-top">
                      {summary ? (
                        <div className="flex items-start gap-1 min-w-0">
                          <button
                            type="button"
                            aria-label={isExpanded ? 'Collapse summary' : 'Expand summary'}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleExpanded(session.id);
                            }}
                            className="flex-none mt-[2px] text-muted-foreground hover:text-foreground"
                          >
                            {isExpanded ? (
                              <ChevronUp className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-foreground truncate">
                              {summary.headline}
                            </div>
                            {isExpanded && (
                              <p className="mt-1 text-[11px] text-muted-foreground whitespace-normal">
                                {summary.paragraph}
                              </p>
                            )}
                          </div>
                        </div>
                      ) : session.first_message ? (
                        <span className="block truncate">
                          {truncateText(getFirstLine(session.first_message), 200)}
                        </span>
                      ) : (
                        <span className="italic text-muted-foreground/60">
                          No messages yet
                        </span>
                      )}
                      {summaryErrors.has(session.id) && (
                        <p className="mt-1 text-[11px] text-red-400">
                          Summary failed: {summaryErrors.get(session.id)}
                        </p>
                      )}
                    </td>
                    <td className="py-2 px-3 align-top">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCopySessionId(session.id);
                        }}
                        className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground transition-colors"
                        title={`Copy full session ID: ${session.id}`}
                      >
                        <span>{session.id.slice(0, 8)}</span>
                        {copiedId === session.id ? (
                          <Check className="h-3 w-3 text-green-500" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </td>
                    <td className="py-2 px-3 align-top">
                      <button
                        type="button"
                        aria-label={summary ? 'Refresh summary' : 'Generate summary'}
                        title={
                          isRefreshing
                            ? 'Generating…'
                            : noChanges
                              ? 'No new messages since last summary.'
                              : summary
                                ? 'Refresh summary'
                                : 'Generate summary'
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          void refreshSummary(session.id);
                        }}
                        disabled={isRefreshing || noChanges}
                        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 disabled:opacity-40"
                      >
                        <RefreshCw
                          className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')}
                        />
                      </button>
                    </td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </AnimatePresence>

        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={setCurrentPage}
        />
      </div>
    </TooltipProvider>
  );
};
