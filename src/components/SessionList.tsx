import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useRef } from 'react';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import { motion, AnimatePresence } from "framer-motion";
import { Copy, Check, RefreshCw, Hash, Trash2, ChevronDown, ChevronUp, ExternalLink, Bot } from "lucide-react";
import { TooltipProvider, TooltipSimple } from "@/components/ui/tooltip-modern";
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
import { pickSessionTitle } from "@/lib/sessionTitle";
import {
  api,
  PROMPT_TEMPLATE_SETTING_KEY,
  ENABLED_SETTING_KEY,
  type Session,
  type SessionSummary,
  type SummaryGenerateResult,
  type CodexSessionEntry,
  type AgentKind,
} from "@/lib/api";
import { useAccounts } from "@/contexts/AccountsContext";
import { logAndForget } from "@/lib/fireAndLog";
import { formatCost } from "@/components/claude-code-session/CostWidget";

// Must match `promptHash` in daemon/services/sessions-summary.ts.
function clientPromptHash(template: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < template.length; i++) {
    hash ^= template.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function formatBytes(bytes: number | undefined | null): string {
  if (typeof bytes !== 'number' || bytes <= 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

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
  sessions: Session[];
  projectPath: string;
  onBack?: () => void;
  onSessionClick?: (session: Session) => void;
  onRefresh?: () => Promise<void> | void;
  onOpenById?: () => void;
  className?: string;
}

export const SessionList: React.FC<SessionListProps> = ({
  sessions,
  projectPath,
  onSessionClick,
  onRefresh,
  onOpenById,
  className,
}) => {
  const { accounts } = useAccounts();
  const [refreshing, setRefreshing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const layout = useLayoutMode();
  const pull = usePullToRefresh(listRef, onRefresh, layout.touch);

  const handleRefreshClick = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopySessionId = (id: string) => {
    void navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => {
      setCopiedId((prev) => (prev === id ? null : prev));
    }, 1500);
  };

  const handleLaunch = useCallback(
    (session: Session) => {
      const event = new CustomEvent('claude-session-selected', {
        detail: { session, projectPath },
      });
      window.dispatchEvent(event);
      onSessionClick?.(session);
    },
    [projectPath, onSessionClick],
  );

  const [codexSessions, setCodexSessions] = useState<CodexSessionEntry[]>([]);
  const [agentFilter, setAgentFilter] = useState<'all' | AgentKind>('all');

  useEffect(() => {
    let cancelled = false;
    api
      .listCodexSessions()
      .then((entries) => {
        if (cancelled) return;
        setCodexSessions(entries);
      })
      .catch(() => {
        if (!cancelled) setCodexSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [sessionCosts, setSessionCosts] = useState<Map<string, number>>(
    () => new Map(),
  );

  useEffect(() => {
    if (!projectPath) {
      setSessionCosts(new Map());
      return;
    }
    let cancelled = false;
    api
      .sessionCostSessions({ projectPath })
      .then((rows) => {
        if (cancelled) return;
        setSessionCosts(new Map(rows.map((r) => [r.session_id, r.cost_usd])));
      })
      .catch(() => {
        if (!cancelled) setSessionCosts(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, sessions]);

  const projectCodexSessions = useMemo(
    () => codexSessions.filter((e) => e.projectPath === projectPath),
    [codexSessions, projectPath],
  );

  const handleLaunchCodex = useCallback(
    (entry: CodexSessionEntry) => {
      const resolvedProjectPath = entry.projectPath ?? projectPath;
      const event = new CustomEvent('codex-session-selected', {
        detail: {
          conversationId: entry.conversationId,
          projectPath: resolvedProjectPath,
          jsonlPath: entry.jsonlPath,
          lastActivity: entry.lastActivity,
        },
      });
      window.dispatchEvent(event);
    },
    [projectPath],
  );

  // `null` = no summary on disk; `undefined` = not yet fetched.
  const [summaries, setSummaries] = useState<Map<string, SessionSummary | null>>(
    new Map(),
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const [summaryRefreshing, setSummaryRefreshing] = useState<Set<string>>(
    new Set(),
  );
  const [summaryErrors, setSummaryErrors] = useState<Map<string, string>>(
    new Map(),
  );
  const [summarizeEnabledForProject, setSummarizeEnabledForProject] =
    useState<boolean | null>(null);
  // Summary IPC must anchor on the resolved account's config dir, never ~/.claude.
  const [resolvedConfigDir, setResolvedConfigDir] = useState<string | null>(null);
  const [activePromptHash, setActivePromptHash] = useState<string | null>(null);

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDeleteId) return;
    const target = sessions.find((s) => s.id === pendingDeleteId);
    if (!target) {
      setPendingDeleteId(null);
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteSession(target.id, target.project_id, target.project_path);
      setPendingDeleteId(null);
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

  useEffect(() => {
    if (!sessions.length || !projectPath) return;
    let cancelled = false;
    logAndForget('session-list:all', Promise.all(
      sessions.map(async (s) => {
        const summary = await api
          .summaryGet(s.id, projectPath, resolvedConfigDir)
          .catch(() => null);
        return [s.id, summary] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setSummaries(new Map(entries));
    }));
    return () => {
      cancelled = true;
    };
  }, [sessions, projectPath, resolvedConfigDir]);

  useEffect(() => {
    let cancelled = false;
    api
      .getSetting(PROMPT_TEMPLATE_SETTING_KEY)
      .then((value) => {
        if (cancelled) return;
        // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- preserved for readability; auto-fix would obscure null-guard intent.
        setActivePromptHash(value && value.trim() ? clientPromptHash(value) : null);
      })
      .catch(() => {
        if (!cancelled) setActivePromptHash(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      .then(([resolved, enabledSetting]) => {
        if (cancelled) return;
        const acct = resolved.claude?.account ?? resolved.codex?.account ?? null;
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
    // `accounts` is a dep so editing per-account summary settings re-resolves the gate.
  }, [projectPath, accounts]);

  useEffect(() => {
    if (!projectPath) return;
    const unsubscribe = api.onSessionSummaryUpdated(({ sessionUuid }) => {
      api
        .summaryGet(sessionUuid, projectPath, resolvedConfigDir)
        .then((summary) => {
          setSummaries((prev) => new Map(prev).set(sessionUuid, summary));
        })
        .catch(() => {
        });
    });
    return () => {
      unsubscribe?.();
    };
  }, [projectPath, resolvedConfigDir]);

  // Seed from getGeneratingSummaryUuids(): the close-time `generating` event can fire before this subscribes.
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
      setSummaryErrors((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
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

  return (
    <TooltipProvider>
      <div className={cn("flex flex-col gap-4 h-full min-h-0", className)}>
      {(onRefresh || onOpenById || sessions.length > 0 || projectCodexSessions.length > 0) && (
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {(() => {
              const claudeCount = agentFilter === 'codex' ? 0 : sessions.length;
              const codexCount = agentFilter === 'claude' ? 0 : projectCodexSessions.length;
              const total = claudeCount + codexCount;
              return `${total} session${total !== 1 ? 's' : ''}`;
            })()}
          </span>
          {projectCodexSessions.length > 0 && sessions.length > 0 && (
            <div
              role="group"
              aria-label="Filter by agent"
              className="inline-flex items-center rounded-md border border-border/60 overflow-hidden text-xs"
            >
              {(['all', 'claude', 'codex'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => { setAgentFilter(value); }}
                  className={cn(
                    "px-2 h-7 capitalize transition-colors",
                    agentFilter === value
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/60",
                  )}
                  aria-pressed={agentFilter === value}
                >
                  {value}
                </button>
              ))}
            </div>
          )}
          {onOpenById && (
            <TooltipSimple content="Open a session by pasting its GUID">
              <button
                type="button"
                onClick={onOpenById}
                className={cn(
                  "inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border/60 text-xs",
                  "text-muted-foreground hover:text-foreground hover:bg-accent transition-colors",
                )}
              >
                <Hash className="h-3 w-3" />
                Open a Session by UUID
              </button>
            </TooltipSimple>
          )}
          {onRefresh && (
            <TooltipSimple content={refreshing ? 'Refreshing…' : 'Refresh session list'}>
              <button
                type="button"
                onClick={() => void handleRefreshClick()}
                disabled={refreshing}
                className={cn(
                  "ml-auto inline-flex items-center justify-center h-8 w-8 rounded-md border border-border/60",
                  "text-muted-foreground hover:text-foreground hover:bg-accent transition-colors",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                )}
                aria-label="Refresh session list"
              >
                <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
              </button>
            </TooltipSimple>
          )}
        </div>
      )}


      {/* Outer div clips the sticky thead to the radius; inner scrolls. One div lets the header bleed past the corners. */}
      <AnimatePresence mode="popLayout">
        <div className="rounded-md border border-border/40 overflow-hidden flex-1 min-h-0 flex flex-col">
          {(pull.progress > 0 || pull.refreshing) && (
            <div
              className="flex items-center justify-center text-muted-foreground overflow-hidden transition-[height]"
              style={{ height: `${Math.min(48, Math.round(pull.progress * 48))}px` }}
              aria-hidden
            >
              <RefreshCw className={cn('h-4 w-4', pull.refreshing && 'animate-spin')} style={{ opacity: Math.min(1, pull.progress) }} />
            </div>
          )}
          <div ref={listRef} className="overflow-y-auto flex-1 min-h-0">
          <table className="w-full text-sm">
            {/* Opaque, no backdrop-blur: rows scroll under the sticky header, and blur bleeds past the rounded corners. */}
            <thead className="sticky top-0 z-10 bg-muted text-[11px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left font-medium py-2 px-3 w-40">Date</th>
                <th className="text-left font-medium py-2 px-3">Summary</th>
                <th className="text-left font-medium py-2 px-3 w-28">Session ID</th>
                <th className="text-right font-medium py-2 px-3 w-24">Size / Cost</th>
                <th className="text-left font-medium py-2 px-3 w-[88px]" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {(agentFilter === 'codex' ? [] : sessions).map((session, index) => {
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
                const cachedSummary = summaries.get(session.id);
                const summary =
                  summarizeEnabledForProject === false ? null : cachedSummary;
                const isExpanded = expanded.has(session.id);
                const sessionTitle = pickSessionTitle({
                  aiTitle: session.ai_title,
                  customTitle: session.custom_title,
                });
                const isRefreshing = summaryRefreshing.has(session.id);
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
                      "border-t border-border/30 transition-colors hover:bg-accent/40",
                      session.todo_data && "bg-primary/5",
                    )}
                  >
                    <td className="py-2 px-3 text-[11px] text-muted-foreground whitespace-nowrap leading-tight align-top">
                      <div className="flex items-start gap-1.5">
                        <TooltipSimple content="Claude session">
                          <span
                            className="text-muted-foreground mt-[1px] shrink-0"
                            aria-label="Claude session"
                          >
                            <Bot className="h-3.5 w-3.5" aria-hidden="true" />
                          </span>
                        </TooltipSimple>
                        <TooltipSimple content="Launch session">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleLaunch(session);
                            }}
                            className="inline-flex items-start gap-1 text-left text-muted-foreground hover:text-foreground hover:underline focus-visible:underline focus:outline-none"
                            aria-label="Launch session"
                          >
                            <span>
                              {firstDate && <div>{fmt(firstDate)}</div>}
                              <div className={firstDate ? 'text-muted-foreground/70' : ''}>
                                {fmt(lastDate)}
                              </div>
                            </span>
                            <ExternalLink
                              className="h-3 w-3 opacity-60 mt-[1px]"
                              aria-hidden="true"
                            />
                          </button>
                        </TooltipSimple>
                      </div>
                    </td>
                    <td className="py-2 px-3 text-xs text-foreground/90 max-w-0 align-top">
                      {/* No fallback to the opening prompt: untitled rows are the ones worth noticing. */}
                      <div className="flex items-start gap-1 min-w-0">
                        {summary && (
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
                        )}
                        <div className="min-w-0 flex-1">
                          <TooltipSimple content="Launch session">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleLaunch(session);
                              }}
                              className={cn(
                                "block w-full min-w-0 truncate text-left hover:underline focus-visible:underline focus:outline-none",
                                sessionTitle || summary
                                  ? "font-medium text-foreground"
                                  : "italic text-muted-foreground/70 hover:text-foreground",
                              )}
                            >
                              {sessionTitle ?? summary?.headline ?? 'No name'}
                            </button>
                          </TooltipSimple>
                          {summary && (
                            <>
                              {sessionTitle && (
                                <span className="block truncate text-muted-foreground">
                                  {summary.headline}
                                </span>
                              )}
                              {isExpanded && <SummaryBody text={summary.paragraph} />}
                            </>
                          )}
                        </div>
                      </div>
                      {summaryErrors.has(session.id) && (
                        <p className="mt-1 text-[11px] text-red-400">
                          Summary failed: {summaryErrors.get(session.id)}
                        </p>
                      )}
                    </td>
                    <td className="py-2 px-3 align-top">
                      <TooltipSimple content={`Copy full session ID: ${session.id}`}>
                        <button
                          type="button"
                          aria-label={`Copy session ID ${session.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopySessionId(session.id);
                          }}
                          className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <span>{session.id.slice(0, 8)}</span>
                          {copiedId === session.id ? (
                            <Check className="h-3 w-3 text-green-500" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      </TooltipSimple>
                    </td>
                    <td className="py-2 px-3 text-right text-[11px] font-mono tabular-nums text-muted-foreground align-top whitespace-nowrap leading-tight">
                      <div
                        title={
                          typeof session.file_size_bytes === 'number'
                            ? `${session.file_size_bytes.toLocaleString()} bytes`
                            : 'Unknown size'
                        }
                      >
                        {formatBytes(session.file_size_bytes)}
                      </div>
                      <div
                        className="text-muted-foreground/70"
                        title={
                          sessionCosts.has(session.id)
                            ? 'Total cost computed from this session’s transcript tokens'
                            : 'No cost recorded yet — open the Costs view to rescan'
                        }
                      >
                        {(() => {
                          const cost = sessionCosts.get(session.id);
                          return cost !== undefined ? formatCost(cost) : '—';
                        })()}
                      </div>
                    </td>
                    <td className="py-2 px-3 align-top">
                      <div className="flex items-center justify-end gap-1">
                        <TooltipSimple content="Launch session">
                          <button
                            type="button"
                            aria-label="Launch session"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleLaunch(session);
                            }}
                            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </button>
                        </TooltipSimple>
                        {summarizeEnabledForProject ? (
                          <TooltipSimple content={
                              isRefreshing
                                ? 'Generating…'
                                : noChanges
                                  ? 'No new messages since last summary.'
                                  : summary
                                    ? 'Refresh summary'
                                    : 'Generate summary'
                            }>
                            <button
                              type="button"
                              aria-label={summary ? 'Refresh summary' : 'Generate summary'}
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
                          </TooltipSimple>
                        ) : null}
                        <TooltipSimple content="Delete session">
                          <button
                            type="button"
                            aria-label="Delete session"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPendingDeleteId(session.id);
                            }}
                            className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </TooltipSimple>
                      </div>
                    </td>
                  </motion.tr>
                );
              })}
              {(agentFilter === 'claude' ? [] : projectCodexSessions).map((entry, index) => {
                const fmt = (d: Date) =>
                  `${d.toLocaleDateString('en-US', {
                    month: 'numeric',
                    day: 'numeric',
                    year: 'numeric',
                  })} ${d.toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}`;
                const lastDate = new Date(entry.lastActivity);
                return (
                  <motion.tr
                    key={`codex-${entry.conversationId}`}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{
                      duration: 0.2,
                      delay: (sessions.length + index) * 0.02,
                      ease: [0.4, 0, 0.2, 1],
                    }}
                    className="border-t border-border/30 transition-colors hover:bg-accent/40"
                  >
                    <td className="py-2 px-3 text-[11px] text-muted-foreground whitespace-nowrap leading-tight align-top">
                      <div className="flex items-start gap-1.5">
                        <TooltipSimple content="Codex session">
                          <span
                            className="text-emerald-600 dark:text-emerald-400 mt-[1px] shrink-0"
                            aria-label="Codex session"
                          >
                            <Bot className="h-3.5 w-3.5" aria-hidden="true" />
                          </span>
                        </TooltipSimple>
                        <TooltipSimple content="Launch Codex session">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleLaunchCodex(entry);
                            }}
                            className="inline-flex items-start gap-1 text-left text-muted-foreground hover:text-foreground hover:underline focus-visible:underline focus:outline-none"
                            aria-label="Launch Codex session"
                          >
                            <span>
                              <div>{fmt(lastDate)}</div>
                            </span>
                            <ExternalLink
                              className="h-3 w-3 opacity-60 mt-[1px]"
                              aria-hidden="true"
                            />
                          </button>
                        </TooltipSimple>
                      </div>
                    </td>
                    <td className="py-2 px-3 text-xs text-foreground/90 max-w-0 align-top">
                      {entry.projectPath ? (
                        <span className="block truncate text-muted-foreground">
                          {entry.projectPath}
                        </span>
                      ) : (
                        <span className="italic text-muted-foreground/60">
                          No project path recorded
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3 align-top">
                      <TooltipSimple content={`Copy full conversation ID: ${entry.conversationId}`}>
                        <button
                          type="button"
                          aria-label={`Copy conversation ID ${entry.conversationId}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopySessionId(entry.conversationId);
                          }}
                          className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <span>{entry.conversationId.slice(0, 8)}</span>
                          {copiedId === entry.conversationId ? (
                            <Check className="h-3 w-3 text-green-500" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      </TooltipSimple>
                    </td>
                    <td className="py-2 px-3 text-right text-[11px] font-mono tabular-nums text-muted-foreground align-top whitespace-nowrap leading-tight">
                      <div>—</div>
                      <div className="text-muted-foreground/70">
                        {(() => {
                          const cost = sessionCosts.get(entry.conversationId);
                          return cost !== undefined ? formatCost(cost) : '—';
                        })()}
                      </div>
                    </td>
                    <td className="py-2 px-3 align-top">
                      <div className="flex items-center justify-end gap-1">
                        <TooltipSimple content="Launch Codex session">
                          <button
                            type="button"
                            aria-label="Launch Codex session"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleLaunchCodex(entry);
                            }}
                            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </button>
                        </TooltipSimple>
                      </div>
                    </td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      </AnimatePresence>
      </div>

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
