import React, { useState, useEffect, useCallback, useMemo } from "react";
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
import { fireAndLog, logAndForget } from "@/lib/fireAndLog";
import {
  LOG_LEVELS,
  LOG_SOURCES,
  LOG_SOURCE_DISPLAY,
  type LogLevel,
} from "@/lib/logSources";
import { useTabContext } from "@/contexts/TabContext";
import { useSaveStatus } from "@/components/settings-panels/saveStatus";
import { sessionNameRegistry } from "@/services/sessionNameRegistry";

const PAGE_SIZE = 50;

type ResizableColKey = "time" | "level" | "source" | "category";
const DEFAULT_COL_WIDTHS: Record<ResizableColKey, number> = {
  time: 160,
  level: 64,
  source: 80,
  category: 96,
};
const MIN_COL_WIDTH = 40;
const COL_WIDTHS_STORAGE_KEY = "omnifex_log_column_widths_v1";

function loadStoredColWidths(): Record<ResizableColKey, number> {
  try {
    const raw = localStorage.getItem(COL_WIDTHS_STORAGE_KEY);
    if (!raw) return DEFAULT_COL_WIDTHS;
    const parsed = JSON.parse(raw) as Partial<Record<ResizableColKey, unknown>> | null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_COL_WIDTHS;
    return {
      time: clampWidth(parsed.time, DEFAULT_COL_WIDTHS.time),
      level: clampWidth(parsed.level, DEFAULT_COL_WIDTHS.level),
      source: clampWidth(parsed.source, DEFAULT_COL_WIDTHS.source),
      category: clampWidth(parsed.category, DEFAULT_COL_WIDTHS.category),
    };
  } catch {
    return DEFAULT_COL_WIDTHS;
  }
}

function clampWidth(n: unknown, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) && n >= MIN_COL_WIDTH
    ? Math.round(n)
    : fallback;
}

function projectBasename(p: string | null | undefined): string | undefined {
  if (!p) return undefined;
  const trimmed = String(p).replace(/[/\\]+$/, "");
  if (!trimmed) return undefined;
  const seg = trimmed.split(/[/\\]/).pop();
  return seg && seg.length > 0 ? seg : undefined;
}

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
  const [olderN, setOlderN] = useState<number>(1);
  const [olderUnit, setOlderUnit] = useState<"h" | "d" | "w" | "m">("d");
  const [verboseHooks, setVerboseHooks] = useState(false);
  const [verboseUsageRunner, setVerboseUsageRunner] = useState(false);
  const [toastOnErrors, setToastOnErrors] = useState(true);
  const [sortBy, setSortBy] = useState<LogOrderBy>("timestamp");
  const [sortDir, setSortDir] = useState<LogOrderDir>("desc");

  const [colWidths, setColWidths] = useState<Record<ResizableColKey, number>>(
    () => loadStoredColWidths(),
  );

  // Registry fallback: log rows outlive the tabs that wrote them.
  const { tabs } = useTabContext();
  const { track } = useSaveStatus();
  const tabIdentityMap = useMemo(() => {
    const m = new Map<string, {
      title?: string;
      projectName?: string;
      claudeSessionId?: string;
    }>();
    for (const [tabId, entry] of Object.entries(sessionNameRegistry.snapshot())) {
      m.set(tabId, {
        title: entry.title,
        projectName: entry.projectName,
        claudeSessionId: entry.claudeSessionId,
      });
    }
    for (const tab of tabs) {
      if (tab.type !== "chat") continue;
      const existing = m.get(tab.id) ?? {};
      m.set(tab.id, {
        title: tab.title?.trim() || existing.title,
        projectName: projectBasename(tab.projectPath) ?? existing.projectName,
        claudeSessionId: tab.sessionId ?? existing.claudeSessionId,
      });
    }
    return m;
  }, [tabs]);

  const displayCategory = useCallback(
    (raw: string | null | undefined): { label: string; tooltip: string } => {
      if (!raw) return { label: "-", tooltip: "" };
      const m = /^session:(.+)$/.exec(raw);
      if (!m) return { label: raw, tooltip: raw };
      const tabId = m[1];
      const id = tabIdentityMap.get(tabId);

      if (id?.projectName && id.claudeSessionId) {
        const label = `session: ${id.projectName} - ${id.claudeSessionId.slice(0, 7)}`;
        return { label, tooltip: `${label}\n${id.claudeSessionId}\n${raw}` };
      }
      if (id?.projectName) {
        const label = `session: ${id.projectName}`;
        return { label, tooltip: `${label}\n${raw}` };
      }
      if (id?.title) {
        const label = `session: ${id.title}`;
        return { label, tooltip: `${label}\n${raw}` };
      }
      const short = tabId.length > 14 ? `…${tabId.slice(-12)}` : tabId;
      return { label: `session ${short}`, tooltip: raw };
    },
    [tabIdentityMap],
  );

  useEffect(() => {
    logAndForget('log-tab:iife', (async () => {
      const h = await api.getSetting('log_verbose_claude_hooks');
      const u = await api.getSetting('log_verbose_usage_runner');
      const t = await api.getSetting('log_error_toast_enabled');
      setVerboseHooks(h === 'true');
      setVerboseUsageRunner(u === 'true');
      setToastOnErrors(t !== 'false');
    })());
  }, []);

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
    logAndForget('log-tab:fetch-logs', fetchLogs());
  }, [fetchLogs]);

  useEffect(() => {
    setPage(0);
  }, [levelFilter, sourceFilter, debouncedSearch, sortBy, sortDir]);

  const toggleSort = (key: LogOrderBy) => {
    if (sortBy === key) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(key);
      setSortDir(key === "timestamp" || key === "level" ? "desc" : "asc");
    }
  };

  const startResize = useCallback(
    (key: ResizableColKey, startX: number, startWidth: number) => {
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const next = Math.max(MIN_COL_WIDTH, Math.round(startWidth + dx));
        setColWidths((prev) => (prev[key] === next ? prev : { ...prev, [key]: next }));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setColWidths((latest) => {
          try {
            localStorage.setItem(COL_WIDTHS_STORAGE_KEY, JSON.stringify(latest));
          } catch {
            // Quota: widths just revert on reload.
          }
          return latest;
        });
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [],
  );

  const ResizeHandle: React.FC<{ colKey: ResizableColKey }> = ({ colKey }) => (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${colKey} column`}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        startResize(colKey, e.clientX, colWidths[colKey]);
      }}
      onClick={(e) => e.stopPropagation()}
      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize select-none hover:bg-foreground/20 active:bg-foreground/30"
    />
  );

  const SortIcon: React.FC<{ k: LogOrderBy }> = ({ k }) => {
    if (sortBy !== k) {
      return <ArrowUpDown className="inline h-3 w-3 ml-1 opacity-30" />;
    }
    return sortDir === "asc"
      ? <ArrowUp className="inline h-3 w-3 ml-1 opacity-80" />
      : <ArrowDown className="inline h-3 w-3 ml-1 opacity-80" />;
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Must match parseOlderThan() in daemon/services/logging.ts.
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
      logAndForget('log-tab:fetch-logs', fetchLogs());
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

      <div className="flex items-center flex-wrap gap-x-6 gap-y-2 mb-4 text-xs text-muted-foreground">
        <span className="font-medium">Verbose info logging:</span>
        <div className="flex items-center gap-2">
          <Switch
            id="verbose-claude-hooks"
            checked={verboseHooks}
            onCheckedChange={(next) => {
              setVerboseHooks(next);
              void track(api.saveSetting('log_verbose_claude_hooks', next ? 'true' : 'false'));
            }}
          />
          <Label htmlFor="verbose-claude-hooks" className="cursor-pointer">
            Claude hook events
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="verbose-usage-runner"
            checked={verboseUsageRunner}
            onCheckedChange={(next) => {
              setVerboseUsageRunner(next);
              void track(api.saveSetting('log_verbose_usage_runner', next ? 'true' : 'false'));
            }}
          />
          <Label htmlFor="verbose-usage-runner" className="cursor-pointer">
            Usage runner
          </Label>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Switch
            id="toast-on-errors"
            checked={toastOnErrors}
            onCheckedChange={(next) => {
              setToastOnErrors(next);
              void track(api.saveSetting('log_error_toast_enabled', next ? 'true' : 'false'));
            }}
          />
          <Label htmlFor="toast-on-errors" className="cursor-pointer">
            Toast on errors
          </Label>
        </div>
      </div>

      <div className="border rounded-lg overflow-hidden flex-1 min-h-0 flex flex-col">
        <div className="flex-1 overflow-y-auto">
          {entries.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              {loading ? "Loading..." : "No log entries found"}
            </div>
          ) : (
            <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
              <colgroup>
                <col style={{ width: colWidths.time }} />
                <col style={{ width: colWidths.level }} />
                <col style={{ width: colWidths.source }} />
                <col style={{ width: colWidths.category }} />
                <col />
              </colgroup>
              <thead className="bg-muted sticky top-0">
                <tr>
                  <th
                    className="relative text-left px-3 py-2 font-medium cursor-pointer hover:text-foreground select-none"
                    onClick={() => toggleSort("timestamp")}
                  >
                    Time<SortIcon k="timestamp" />
                    <ResizeHandle colKey="time" />
                  </th>
                  <th
                    className="relative text-left px-3 py-2 font-medium cursor-pointer hover:text-foreground select-none"
                    onClick={() => toggleSort("level")}
                    title="Sorted by severity (error > warn > info > debug), not alphabetically."
                  >
                    Level<SortIcon k="level" />
                    <ResizeHandle colKey="level" />
                  </th>
                  <th
                    className="relative text-left px-3 py-2 font-medium cursor-pointer hover:text-foreground select-none"
                    onClick={() => toggleSort("source")}
                  >
                    Source<SortIcon k="source" />
                    <ResizeHandle colKey="source" />
                  </th>
                  <th
                    className="relative text-left px-3 py-2 font-medium cursor-pointer hover:text-foreground select-none"
                    onClick={() => toggleSort("category")}
                  >
                    Category<SortIcon k="category" />
                    <ResizeHandle colKey="category" />
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
                      <td
                        className="px-3 py-2 text-xs text-muted-foreground truncate"
                        title={displayCategory(entry.category).tooltip}
                      >
                        {displayCategory(entry.category).label}
                      </td>
                      <td className="px-3 py-2 text-xs truncate">
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
                logAndForget('log-tab:prune', handlePruneClick(
                  `${olderN}${olderUnit}`,
                  `older than ${olderN} ${unitWord}${plural}`,
                ));
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
