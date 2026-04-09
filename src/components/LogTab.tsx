import React, { useState, useEffect, useCallback } from "react";
import {
  Search,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Trash2,
  AlertTriangle,
  Loader2,
  ScrollText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
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
import { api, type LogEntry, type LogQueryResult } from "@/lib/api";

const PAGE_SIZE = 50;

const LEVEL_COLORS: Record<string, string> = {
  error: "text-red-400",
  warn: "text-yellow-400",
  info: "text-blue-400",
  debug: "text-gray-400",
};

const LEVEL_BG: Record<string, string> = {
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

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const result: LogQueryResult = await api.logQuery({
        level: levelFilter === "all" ? undefined : levelFilter,
        source: sourceFilter === "all" ? undefined : sourceFilter,
        search: debouncedSearch || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setEntries(result.entries);
      setTotal(result.total);
    } catch (err) {
      console.error("Failed to fetch logs:", err);
    } finally {
      setLoading(false);
    }
  }, [levelFilter, sourceFilter, debouncedSearch, page]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Reset to page 0 when filters change
  useEffect(() => {
    setPage(0);
  }, [levelFilter, sourceFilter, debouncedSearch]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const handlePruneClick = async (olderThan: string | undefined, label: string) => {
    try {
      const count = await api.logCount();
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
    <Card className="p-6">
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
            <SelectItem value="error">Error</SelectItem>
            <SelectItem value="warn">Warn</SelectItem>
            <SelectItem value="info">Info</SelectItem>
            <SelectItem value="debug">Debug</SelectItem>
          </SelectContent>
        </Select>

        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Sources</SelectItem>
            <SelectItem value="frontend">Frontend</SelectItem>
            <SelectItem value="backend">Backend</SelectItem>
          </SelectContent>
        </Select>

        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search messages..."
            className="pl-9"
          />
        </div>

        <Button variant="outline" size="sm" onClick={fetchLogs} disabled={loading}>
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
        </Button>
      </div>

      {/* Log table */}
      <div className="border rounded-lg overflow-hidden">
        <div className="max-h-[500px] overflow-y-auto">
          {entries.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              {loading ? "Loading..." : "No log entries found"}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-medium w-40">Time</th>
                  <th className="text-left px-3 py-2 font-medium w-16">Level</th>
                  <th className="text-left px-3 py-2 font-medium w-20">Source</th>
                  <th className="text-left px-3 py-2 font-medium w-24">Category</th>
                  <th className="text-left px-3 py-2 font-medium">Message</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <React.Fragment key={entry.id}>
                    <tr
                      className={`border-t cursor-pointer hover:bg-muted/30 ${LEVEL_BG[entry.level] || ""}`}
                      onClick={() =>
                        setExpandedId(expandedId === entry.id ? null : (entry.id ?? null))
                      }
                    >
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {formatTimestamp(entry.timestamp)}
                      </td>
                      <td className={`px-3 py-2 font-mono text-xs font-bold uppercase ${LEVEL_COLORS[entry.level] || ""}`}>
                        {entry.level}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                          entry.source === "backend"
                            ? "bg-purple-500/20 text-purple-300"
                            : "bg-sky-500/20 text-sky-300"
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
                                    return JSON.stringify(JSON.parse(entry.metadata!), null, 2);
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
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePruneClick("1w", "older than 1 week")}
          >
            <Trash2 className="w-3 h-3 mr-1" />
            Older than 1 week
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePruneClick("1m", "older than 1 month")}
          >
            <Trash2 className="w-3 h-3 mr-1" />
            Older than 1 month
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => handlePruneClick(undefined, "all")}
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
            <Button variant="outline" onClick={() => setPruneDialog({ open: false, label: "" })}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmPrune}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
};
