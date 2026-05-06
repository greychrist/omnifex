import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Copy, Check, RefreshCw, Hash, Trash2 } from "lucide-react";
import { Pagination } from "@/components/ui/pagination";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { truncateText, getFirstLine } from "@/lib/date-utils";
import {
  api,
  PROMPT_TEMPLATE_SETTING_KEY,
  ENABLED_SETTING_KEY,
  type Session,
  type SessionSummary,
  type SummaryGenerateResult,
} from "@/lib/api";
import { useAccounts } from "@/contexts/AccountsContext";

/**
 * FNV-1a hash mirror — must produce the same output as `promptHash` in
 * `electron/services/sessions-summary.ts`. The renderer hashes the
 * locally-cached prompt template (read from app_settings) so it can
 * decide whether the size-change gate should treat the cached sidecar
 * as fresh, without an extra IPC round-trip per row.
 */
function clientPromptHash(template: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < template.length; i++) {
    hash ^= template.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Render the body of a session summary. The current default prompt asks
 * the model to produce markdown-style "- " bullet lines inside the
 * `<paragraph>` tag; older cached summaries are still plain prose. When
 * every non-empty line begins with `- ` or `* ` we render a tight bullet
 * list, otherwise we fall back to a plain paragraph so legacy sidecars
 * keep rendering correctly until they're regenerated.
 */
const SummaryBody: React.FC<{ text: string }> = ({ text }) => {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const allBullets =
    lines.length > 0 && lines.every((l) => /^[-*]\s+/.test(l));
  if (allBullets) {
    return (
      <ul className="mt-1 list-disc pl-4 space-y-0.5 text-[11px] text-muted-foreground">
        {lines.map((l, i) => (
          <li key={i}>{l.replace(/^[-*]\s+/, '')}</li>
        ))}
      </ul>
    );
  }
  return (
    <p className="mt-1 text-[11px] text-muted-foreground whitespace-normal">
      {text}
    </p>
  );
};

/**
 * Human-readable explanation for each `skipped` reason. Surfaced inline
 * on the row so the manual refresh button gives honest feedback when the
 * account isn't fully configured for summarization.
 */
function skipReasonMessage(reason: Extract<SummaryGenerateResult, { status: 'skipped' }>['reason']): string {
  switch (reason) {
    case 'toggle-off':
      return 'Summaries are off for this account. Enable in Account Settings.';
    case 'no-model':
      return 'No summary model selected. Pick one in Account Settings.';
    case 'no-account':
      return 'No account resolved for this project — add a path rule in Account Settings.';
    case 'empty-session':
      return 'No user/assistant messages to summarize yet.';
    case 'jsonl-missing':
      return 'Session file not found on disk.';
    case 'jsonl-unreadable':
      return 'Session file unreadable.';
  }
}

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
  // We use the accounts context not for direct lookups but to re-trigger
  // the per-project resolution below when the user toggles the
  // "Generate Summaries" / model settings on the resolved account from
  // somewhere else in the app — without this dep the summarize state
  // for an open SessionList wouldn't update until the user navigated
  // away and back.
  const { accounts } = useAccounts();
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
  const [summaryRefreshing, setSummaryRefreshing] = useState<Set<string>>(
    new Set(),
  );
  // Per-row error message for the most recent failed manual refresh.
  // Auto-clears after a few seconds. No toast library is wired in this
  // codebase, so we surface failures inline.
  const [summaryErrors, setSummaryErrors] = useState<Map<string, string>>(
    new Map(),
  );
  // Whether the project's resolved account has summarization enabled.
  // Drives whether we even render the manual refresh button on each row —
  // when the account toggle is off or no model is set, the button is
  // hidden entirely (rather than visible-but-clicking-yields-an-error).
  // Null until the resolution returns; we render no button while it's
  // pending to avoid a flash of incorrect UI.
  const [summarizeEnabledForProject, setSummarizeEnabledForProject] =
    useState<boolean | null>(null);
  // The resolved account's config_dir — held at tab/view level so every
  // summaryGet / summaryGenerate call anchors paths to the right account
  // root (NOT ~/.claude). Null until resolution returns.
  const [resolvedConfigDir, setResolvedConfigDir] = useState<string | null>(null);
  // Hash of the active prompt template — used to decide whether the
  // refresh button should treat an unchanged JSONL as "nothing to do".
  // A prompt edit changes the hash and re-enables the button.
  const [activePromptHash, setActivePromptHash] = useState<string | null>(null);

  // Delete-session flow: clicking the per-row trash icon parks the
  // session id here, which opens the confirm dialog. Confirming calls
  // the IPC and then onRefresh() to reload the list. Errors surface
  // inline in the dialog so the row stays addressable.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDeleteId) return;
    const target = sessions.find((s) => s.id === pendingDeleteId);
    if (!target) {
      // Row vanished from under us (refresh race); just close the dialog.
      setPendingDeleteId(null);
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteSession(target.id, target.project_id, target.project_path);
      setPendingDeleteId(null);
      // Drop any in-memory summary state for the deleted row so the
      // list doesn't briefly re-render the row with a stale summary if
      // the parent's refresh hasn't completed yet.
      setSummaries((prev) => {
        const next = new Map(prev);
        next.delete(target.id);
        return next;
      });
      if (onRefresh) await onRefresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }, [pendingDeleteId, sessions, onRefresh]);

  // Fetch summaries in parallel whenever the session list or project path
  // changes. The IPC layer answers each call independently; we don't await
  // them serially.
  useEffect(() => {
    if (!sessions.length || !projectPath) return;
    let cancelled = false;
    Promise.all(
      sessions.map(async (s) => {
        const summary = await api
          .summaryGet(s.id, projectPath, resolvedConfigDir)
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
  }, [sessions, projectPath, resolvedConfigDir]);

  // Read the active prompt template once on mount and hash it. Used by
  // the noChanges check below — a prompt edit since the cached sidecar
  // was written re-enables the refresh button.
  useEffect(() => {
    let cancelled = false;
    api
      .getSetting(PROMPT_TEMPLATE_SETTING_KEY)
      .then((value) => {
        if (cancelled) return;
        // Empty / missing → backend will fall through to its DEFAULT
        // prompt; we represent that as null on this side and skip the
        // hash compare (any cached sidecar is treated as fresh wrt
        // prompt). The next refresh from the backend will write a real
        // promptHash.
        setActivePromptHash(value && value.trim() ? clientPromptHash(value) : null);
      })
      .catch(() => {
        if (!cancelled) setActivePromptHash(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Resolve which account "owns" this project so we can (a) decide
  // whether the manual refresh button should even render and (b) hold
  // its config_dir at this view level for downstream summary IPC calls.
  useEffect(() => {
    if (!projectPath) {
      setSummarizeEnabledForProject(null);
      setResolvedConfigDir(null);
      return;
    }
    let cancelled = false;
    Promise.all([
      api.resolveAccountForProject(projectPath),
      api.getSetting(ENABLED_SETTING_KEY),
    ])
      .then(([acct, enabledSetting]) => {
        if (cancelled) return;
        // Master "Enable session summaries" toggle in Settings → Session
        // Summaries. Off → cached sidecars hide and the refresh button
        // disappears (rows fall back to first-message previews). On
        // requires a model on the resolved account before the refresh
        // button is shown. The auto-on-close toggle is unrelated here —
        // it only gates the lifecycle hook in main.ts.
        const enabled = enabledSetting === null ? true : enabledSetting === 'true';
        setSummarizeEnabledForProject(!!(enabled && acct?.summaryModel));
        setResolvedConfigDir(acct?.config_dir ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setSummarizeEnabledForProject(false);
        setResolvedConfigDir(null);
      });
    return () => {
      cancelled = true;
    };
    // `accounts` is intentionally a dep: when the AccountsContext
    // refreshes after the user edits per-account summary settings, we
    // re-resolve so the gate flips without needing a tab switch.
  }, [projectPath, accounts]);

  // Subscribe to backend summary-updated events so auto-on-close
  // generations refresh the matching row in real time. We re-fetch the
  // sidecar via the same `summaryGet` path so the row source-of-truth
  // stays consistent with the disk.
  useEffect(() => {
    if (!projectPath) return;
    const unsubscribe = api.onSessionSummaryUpdated(({ sessionUuid }) => {
      api
        .summaryGet(sessionUuid, projectPath, resolvedConfigDir)
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

  // Subscribe to backend generation-state events so the per-row refresh
  // icon spins for *background* auto-on-close runs (not just the
  // user's manual button click). The same `summaryRefreshing` set
  // drives both — manual clicks add+remove locally inside
  // `refreshSummary`, backend events add+remove via this listener.
  //
  // We ALSO query `getGeneratingSummaryUuids()` once on mount and seed
  // the set from the result. This catches the back-button race: when
  // the user clicks back inside a session, the close lifecycle fires
  // its `generating: true` event in the same frame as the navigation
  // — often before this effect has subscribed. The mount-time query
  // recovers any in-flight generation we'd otherwise miss.
  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    api
      .getGeneratingSummaryUuids()
      .then((uuids) => {
        if (cancelled || uuids.length === 0) return;
        setSummaryRefreshing((prev) => {
          const next = new Set(prev);
          for (const id of uuids) next.add(id);
          return next;
        });
      })
      .catch(() => {
        // Silent — worst case the spinner doesn't appear; the
        // updated event will still refresh the row when it arrives.
      });
    const unsubscribe = api.onSessionSummaryGenerating(
      ({ sessionUuid, generating }) => {
        setSummaryRefreshing((prev) => {
          const next = new Set(prev);
          if (generating) next.add(sessionUuid);
          else next.delete(sessionUuid);
          return next;
        });
      },
    );
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [projectPath]);

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
      // Min-spinner: even instant returns (toggle-off, size-unchanged)
      // flash the spinner long enough to feel like a click registered.
      const minSpinner = new Promise<void>((resolve) => setTimeout(resolve, 400));
      const showError = (message: string) => {
        setSummaryErrors((prev) => new Map(prev).set(id, message));
        setTimeout(() => {
          setSummaryErrors((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Map(prev);
            next.delete(id);
            return next;
          });
        }, 8000);
      };
      try {
        const [result] = await Promise.all([
          api.summaryGenerate(id, projectPath, resolvedConfigDir),
          minSpinner,
        ]);
        switch (result.status) {
          case 'generated':
          case 'unchanged':
            setSummaries((prev) => new Map(prev).set(id, result.summary));
            break;
          case 'skipped':
            showError(skipReasonMessage(result.reason));
            break;
          case 'malformed-response':
            showError('Model returned an invalid response. Try again.');
            break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Summary failed.';
        console.error('[SessionList] summaryGenerate failed:', err);
        // Don't dismiss the spinner before the min duration even on
        // failure — keeps the UI honest about a click having registered.
        await minSpinner.catch(() => {});
        showError(message);
      } finally {
        setSummaryRefreshing((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [projectPath, summaryRefreshing, resolvedConfigDir],
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
                // Hide cached summaries when the resolved account has
                // summarization turned off — the user toggled off and
                // expects them gone from the UI without having to manually
                // delete sidecar files. `null` (resolution still pending)
                // and `true` keep showing whatever's cached.
                const cachedSummary = summaries.get(session.id);
                const summary =
                  summarizeEnabledForProject === false ? null : cachedSummary;
                const isRefreshing = summaryRefreshing.has(session.id);
                // Refresh button is a no-op when the JSONL size hasn't
                // changed AND the cached summary was produced by the
                // current prompt template. A promptHash mismatch
                // re-enables the button so prompt iteration lands —
                // the backend size-gate has the matching escape hatch.
                // When activePromptHash is null we couldn't load the
                // prompt setting (or it's empty / using the default),
                // so we don't gate on it.
                const sizeMatches =
                  !!summary &&
                  typeof session.file_size_bytes === 'number' &&
                  session.file_size_bytes === summary.jsonlSize;
                const promptMatches =
                  activePromptHash == null ||
                  summary?.promptHash === activePromptHash;
                const noChanges = sizeMatches && promptMatches;
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
                        <div className="min-w-0">
                          <div className="font-medium text-foreground truncate">
                            {summary.headline}
                          </div>
                          <SummaryBody text={summary.paragraph} />
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
                      {summarizeEnabledForProject ? (
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
                      ) : null}
                    </td>
                    <td className="py-2 px-3 align-top">
                      <button
                        type="button"
                        aria-label="Delete session"
                        title="Delete session"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingDeleteId(session.id);
                        }}
                        className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
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

      {/* Delete-session confirmation. Mounted once at panel level; opens
          when pendingDeleteId is set. Cancel just clears the id; Delete
          calls handleConfirmDelete which clears it on success or sets
          deleteError on failure. */}
      <Dialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setPendingDeleteId(null);
            setDeleteError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this session?</DialogTitle>
            <DialogDescription>
              This permanently removes the session transcript and any
              cached summary or todo files. It cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <div className="text-xs text-red-400 px-1">{deleteError}</div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPendingDeleteId(null);
                setDeleteError(null);
              }}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleConfirmDelete()}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
};
