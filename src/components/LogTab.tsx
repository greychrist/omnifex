import React, { useState, useEffect, useCallback } from "react";
import {
  Search,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Trash2,
  AlertTriangle,
  ScrollText,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, type LogEntry, type LogQueryResult, type LogOrderBy, type LogOrderDir } from "@/lib/api";
import { fireAndLog } from "@/lib/fireAndLog";
import {
  LOG_LEVELS,
  LOG_SOURCES,
  LOG_SOURCE_DISPLAY,
  type LogLevel,
} from "@/lib/logSources";

const PAGE_SIZE = 50;

const LEVEL_LABEL: Record<LogLevel, string> = {
  error: "Error",
  warn: "Warn",
  info: "Info",
  debug: "Debug",
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  error: "text-red-400",
  warn: "text-yellow-400",
  info: "text-blue-400",
  debug: "text-gray-400",
};

const LEVEL_BG: Record<LogLevel, string> = {
  error: "bg-red-500/10",
  warn: "bg-yellow-500/10",
  info: "bg-blue-500/10",
  debug: "bg-gray-500/10",
};

export const LogTab: React.FC = () => {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [pruneDialog, setPruneDialog] = useState<{ open: boolean; olderThan?: string; label: string }>({
    open: false,
    label: "",
  });
  const [pruneCount, setPruneCount] = useState<number | null>(null);
  // Pending "older than N <unit>" selection. The actual delete is only
  // triggered by the adjacent trash button — changing either dropdown
  // alone is non-destructive.
  const [olderN, setOlderN] = useState<number>(1);
  const [olderUnit, setOlderUnit] = useState<"h" | "d" | "w" | "m">("d");
  // Verbose-source toggles. Default off — these two sources fire constantly
  // and were originally added for debugging. The settings are read by the
  // main-process LoggingService on every writeBatch, so flipping these
  // takes effect on the next event without a restart.
  const [verboseHooks, setVerboseHooks] = useState(false);
  const [verboseUsageRunner, setVerboseUsageRunner] = useState(false);
  // Default ON — only flips off if the user has explicitly disabled it.
  const [toastOnErrors, setToastOnErrors] = useState(true);
  // Sort state. Server-side sort (the query is paginated, so reordering
  // only the current page would be misleading). Default matches the
  // backend's pre-sort behavior: newest first by timestamp.
  const [sortBy, setSortBy] = useState<LogOrderBy>("timestamp");
  const [sortDir, setSortDir] = useState<LogOrderDir>("desc");

  useEffect(() => {
    (async () => {
      const h = await api.getSetting('log_verbose_claude_hooks');
      const u = await api.getSetting('log_verbose_usage_runner');
      const t = await api.getSetting('log_error_toast_enabled');
      setVerboseHooks(h === 'true');
      setVerboseUsageRunner(u === 'true');
      // Default on: only the literal string "false" disables it.
      setToastOnErrors(t !== 'false');
    })();
  }, []);

  // When the user clicks "View in Log" on an error toast, App.tsx fires this
  // event after focusing the Settings tab. Snap our filters so the error is
  // immediately visible: level=error, all sources, no search.
  useEffect(() => {
    const handler = () => {
      setLevelFilter('error');
      setSourceFilter('all');
      setSearchQuery('');
      setPage(0);
    };
    window.addEventListener('log:focus-error-view', handler);
    return () => { window.removeEventListener('log:focus-error-view', handler); };
  }, []);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedSearch(searchQuery); }, 300);
    return () => { clearTimeout(timer); };
  }, [searchQuery]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const result: LogQueryResult = await api.logQuery({
        levels: levelFilter === "all" ? undefined : [levelFilter],
        sources: sourceFilter === "all" ? undefined : [sourceFilter],
        search: debouncedSearch || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        orderBy: sortBy,
        orderDir: sortDir,
      });
      setEntries(result.entries);
      setTotal(result.total);
    } catch (err) {
      console.error("Failed to fetch logs:", err);
    } finally {
      setLoading(false);
    }
  }, [levelFilter, sourceFilter, debouncedSearch, page, sortBy, sortDir]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Reset to page 0 when filters or sort change — otherwise the user
  // re-sorts and lands deep in the middle of an unfamiliar dataset.
  useEffect(() => {
    setPage(0);
  }, [levelFilter, sourceFilter, debouncedSearch, sortBy, sortDir]);

  // Click a column header to sort by it. Same column → flip direction;
  // new column → pick a useful default (descending for timestamp and
  // level — newest / most severe first; ascending for alphabetical
  // columns where A-Z reads more naturally). Mirrors ProjectList.tsx.
  const toggleSort = (key: LogOrderBy) => {
    if (sortBy === key) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(key);
      setSortDir(key === "timestamp" || key === "level" ? "desc" : "asc");
    }
  };

  const SortIcon: React.FC<{ k: LogOrderBy }> = ({ k }) => {
    if (sortBy !== k) {
      return <ArrowUpDown className="inline h-3 w-3 ml-1 opacity-30" />;
    }
    return sortDir === "asc"
      ? <ArrowUp className="inline h-3 w-3 ml-1 opacity-80" />
      : <ArrowDown className="inline h-3 w-3 ml-1 opacity-80" />;
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Compute the ISO cutoff for a relative "olderThan" string so we can ask the
  // backend for a count of entries that will *actually* be deleted. Keep this
  // in sync with parseOlderThan() in electron/services/logging.ts — at some
  // point this should live in a shared module.
  const olderThanCutoff = (olderThan: string | undefined): string | undefined => {
    if (!olderThan) return undefined;
    const now = Date.now();
    const match = /^(\d+)([hdwm])$/.exec(olderThan);
    if (!match) return undefined;
    const n = Number(match[1]);
    const unitMs =
      match[2] === "h" ? 60 * 60 * 1000 :
      match[2] === "d" ? 24 * 60 * 60 * 1000 :
      match[2] === "w" ? 7 * 24 * 60 * 60 * 1000 :
      match[2] === "m" ? 30 * 24 * 60 * 60 * 1000 :
      0;
    if (unitMs === 0) return undefined;
    return new Date(now - n * unitMs).toISOString();
  };

  const handlePruneClick = async (olderThan: string | undefined, label: string) => {
    try {
      // For "older than X" prune, count rows strictly before the cutoff so the
      // dialog shows an accurate number. For "all", fall back to the unfiltered count.
      const cutoff = olderThanCutoff(olderThan);
      const count = await api.logCount(cutoff ? { until: cutoff } : undefined);
      setPruneCount(count);
      setPruneDialog({ open: true, olderThan, label });
    } catch (err) {
      console.error("Failed to get log count:", err);
    }
  };

  const confirmPrune = async () => {
    try {
      await api.logPrune(pruneDialog.olderThan);
      setPruneDialog({ open: false, label: "" });
      setPruneCount(null);
      setPage(0);
      fetchLogs();
    } catch (err) {
      console.error("Failed to prune logs:", err);
    }
  };

  const formatTimestamp = (ts: string) => {
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return ts;
    }
  };

  return (
    <Card className="p-6 flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 mb-4">
        <ScrollText className="w-5 h-5 text-foreground/70" />
        <h3 className="text-lg font-semibold">Application Logs</h3>
        <span className="text-sm text-muted-foreground ml-auto">
          {total.toLocaleString()} total entries
        </span>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 mb-4">
        <Select value={levelFilter} onValueChange={setLevelFilter}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="Level" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Levels</SelectItem>
            {LOG_LEVELS.map((level) => (
              <SelectItem key={level} value={level}>{LEVEL_LABEL[level]}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Sources</SelectItem>
            {LOG_SOURCES.map((source) => (
              <SelectItem key={source} value={source}>
                {LOG_SOURCE_DISPLAY[source].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); }}
            placeholder="Search messages..."
            className="pl-9"
          />
        </div>

        <Button variant="outline" size="sm" onClick={fireAndLog('log-tab:refresh', fetchLogs)} disabled={loading}>
          {loading ? (
            <Spinner />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
        </Button>
      </div>

      {/* Verbose-source toggles. These two streams (Claude hook events and
          the usage CLI runner) emit info entries on nearly every action and
          were originally turned on for debugging. Off by default; warnings
          and errors from these sources always flow through regardless. */}
      <div className="flex items-center flex-wrap gap-x-6 gap-y-2 mb-4 text-xs text-muted-foreground">
        <span className="font-medium">Verbose info logging:</span>
        <div className="flex items-center gap-2">
          <Switch
            id="verbose-claude-hooks"
            checked={verboseHooks}
            onCheckedChange={fireAndLog('log-tab:checked-change', async (next) => {
              setVerboseHooks(next);
              try {
                await api.saveSetting('log_verbose_claude_hooks', next ? 'true' : 'false');
              } catch (err) {
                console.error('Failed to save log_verbose_claude_hooks:', err);
              }
            })}
          />
          <Label htmlFor="verbose-claude-hooks" className="cursor-pointer">
            Claude hook events
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="verbose-usage-runner"
            checked={verboseUsageRunner}
            onCheckedChange={fireAndLog('log-tab:checked-change', async (next) => {
              setVerboseUsageRunner(next);
              try {
                await api.saveSetting('log_verbose_usage_runner', next ? 'true' : 'false');
              } catch (err) {
                console.error('Failed to save log_verbose_usage_runner:', err);
              }
            })}
          />
          <Label htmlFor="verbose-usage-runner" className="cursor-pointer">
            Usage runner
          </Label>
        </div>
        {/* Notification side — independent of the two verbose-info toggles
            above. Errors always get persisted to the log; this only gates
            whether a toast also pops in the corner when one is recorded. */}
        <div className="ml-auto flex items-center gap-2">
          <Switch
            id="toast-on-errors"
            checked={toastOnErrors}
            onCheckedChange={fireAndLog('log-tab:checked-change', async (next) => {
              setToastOnErrors(next);
              try {
                await api.saveSetting('log_error_toast_enabled', next ? 'true' : 'false');
              } catch (err) {
                console.error('Failed to save log_error_toast_enabled:', err);
              }
            })}
          />
          <Label htmlFor="toast-on-errors" className="cursor-pointer">
            Toast on errors
          </Label>
        </div>
      </div>

      {/* Log table */}
      <div className="border rounded-lg overflow-hidden flex-1 min-h-0 flex flex-col">
        <div className="flex-1 overflow-y-auto">
          {entries.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              {loading ? "Loading..." : "No log entries found"}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted sticky top-0">
                <tr>
                  <th
                    className="text-left px-3 py-2 font-medium w-40 cursor-pointer hover:text-foreground select-none"
                    onClick={() => { toggleSort("timestamp"); }}
                  >
                    Time<SortIcon k="timestamp" />
                  </th>
                  <th
                    className="text-left px-3 py-2 font-medium w-16 cursor-pointer hover:text-foreground select-none"
                    onClick={() => { toggleSort("level"); }}
                    title="Sorted by severity (error > warn > info > debug), not alphabetically."
                  >
                    Level<SortIcon k="level" />
                  </th>
                  <th
                    className="text-left px-3 py-2 font-medium w-20 cursor-pointer hover:text-foreground select-none"
                    onClick={() => { toggleSort("source"); }}
                  >
                    Source<SortIcon k="source" />
                  </th>
                  <th
                    className="text-left px-3 py-2 font-medium w-24 cursor-pointer hover:text-foreground select-none"
                    onClick={() => { toggleSort("category"); }}
                  >
                    Category<SortIcon k="category" />
                  </th>
                  <th
                    className="text-left px-3 py-2 font-medium cursor-pointer hover:text-foreground select-none"
                    onClick={() => { toggleSort("message"); }}
                  >
                    Message<SortIcon k="message" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <React.Fragment key={entry.id}>
                    <tr
                      className={`border-t cursor-pointer hover:bg-muted/30 ${LEVEL_BG[entry.level as LogLevel] || ""}`}
                      onClick={() =>
                        { setExpandedId(expandedId === entry.id ? null : (entry.id ?? null)); }
                      }
                    >
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {formatTimestamp(entry.timestamp)}
                      </td>
                      <td className={`px-3 py-2 font-mono text-xs font-bold uppercase ${LEVEL_COLORS[entry.level as LogLevel] || ""}`}>
                        {entry.level}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                          LOG_SOURCE_DISPLAY[entry.source as keyof typeof LOG_SOURCE_DISPLAY]?.chipClass
                            || "bg-foreground/10 text-foreground/60"
                        }`}>
                          {entry.source}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-[120px]">
                        {entry.category || "-"}
                      </td>
                      <td className="px-3 py-2 text-xs truncate max-w-[400px]">
                        {entry.message}
                      </td>
                    </tr>
                    {expandedId === entry.id && (
                      <tr className="border-t bg-muted/20">
                        <td colSpan={5} className="px-4 py-3">
                          <pre className="text-xs font-mono whitespace-pre-wrap break-all">
                            {entry.message}
                          </pre>
                          {entry.metadata && (
                            <div className="mt-2 pt-2 border-t border-border/50">
                              <span className="text-xs font-semibold text-muted-foreground">Metadata:</span>
                              <pre className="text-xs font-mono whitespace-pre-wrap break-all mt-1">
                                {(() => {
                                  try {
                                    return JSON.stringify(JSON.parse(entry.metadata), null, 2);
                                  } catch {
                                    return entry.metadata;
                                  }
                                })()}
                              </pre>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Footer: pagination + clear */}
      <div className="flex items-center justify-between mt-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {total > 0
              ? `Showing ${page * PAGE_SIZE + 1}-${Math.min((page + 1) * PAGE_SIZE, total)} of ${total.toLocaleString()}`
              : "No entries"}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => { setPage((p) => p - 1); }}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages - 1}
            onClick={() => { setPage((p) => p + 1); }}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex items-center gap-2">
          {/* "Older than N <unit>" — count dropdown + unit dropdown + trash.
              Cycling either dropdown is non-destructive; only the trash
              button opens the confirmation dialog. */}
          <div className="flex items-center gap-1 rounded-md border border-input pl-2">
            <span className="text-xs text-muted-foreground whitespace-nowrap">Older than</span>
            <Select value={String(olderN)} onValueChange={(v) => { setOlderN(Number(v)); }}>
              <SelectTrigger className="h-7 w-14 border-0 px-2 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, (_, i) => i + 1).map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={olderUnit}
              onValueChange={(v) => { setOlderUnit(v as "h" | "d" | "w" | "m"); }}
            >
              <SelectTrigger className="h-7 w-24 border-0 px-2 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="h">hour{olderN === 1 ? "" : "s"}</SelectItem>
                <SelectItem value="d">day{olderN === 1 ? "" : "s"}</SelectItem>
                <SelectItem value="w">week{olderN === 1 ? "" : "s"}</SelectItem>
                <SelectItem value="m">month{olderN === 1 ? "" : "s"}</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => {
                const unitWord = { h: "hour", d: "day", w: "week", m: "month" }[olderUnit];
                const plural = olderN === 1 ? "" : "s";
                handlePruneClick(
                  `${olderN}${olderUnit}`,
                  `older than ${olderN} ${unitWord}${plural}`,
                );
              }}
              aria-label={`Delete logs older than ${olderN} ${{ h: "hour", d: "day", w: "week", m: "month" }[olderUnit]}${olderN === 1 ? "" : "s"}`}
            >
              <Trash2 className="w-3 h-3 mr-1" />
              Clear
            </Button>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={fireAndLog('log-tab:click', () => handlePruneClick(undefined, "all"))}
          >
            <Trash2 className="w-3 h-3 mr-1" />
            Clear all
          </Button>
        </div>
      </div>

      {/* Prune confirmation dialog */}
      <Dialog open={pruneDialog.open} onOpenChange={(open) => !open && setPruneDialog({ open: false, label: "" })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-yellow-500" />
              Clear Log Entries
            </DialogTitle>
            <DialogDescription>
              This will permanently delete {pruneDialog.label === "all" ? "all" : ""}{" "}
              {pruneCount !== null ? `${pruneCount.toLocaleString()} ` : ""}
              log entries{pruneDialog.label !== "all" ? ` ${pruneDialog.label}` : ""}. This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setPruneDialog({ open: false, label: "" }); }}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={fireAndLog('log-tab:click', confirmPrune)}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
};
