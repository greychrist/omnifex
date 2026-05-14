import React, { useState, useEffect, useCallback } from "react";
import { CheckCircle, XCircle, Loader2, AlertTriangle, Ban, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { api, type SessionMcpServerStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

interface SessionMCPStatusProps {
  tabId: string;
}

const STATUS_ICON: Record<string, React.ElementType> = {
  connected: CheckCircle,
  failed: XCircle,
  "needs-auth": AlertTriangle,
  pending: Loader2,
  disabled: Ban,
};

const STATUS_COLOR: Record<string, string> = {
  connected: "text-emerald-500",
  failed: "text-destructive",
  "needs-auth": "text-yellow-500",
  pending: "text-muted-foreground animate-spin",
  disabled: "text-muted-foreground",
};

const STATUS_BADGE: Record<string, string> = {
  connected: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  failed: "bg-destructive/10 text-destructive border-destructive/20",
  "needs-auth": "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
  pending: "bg-muted text-muted-foreground border-border",
  disabled: "bg-muted text-muted-foreground border-border",
};

export const SessionMCPStatus: React.FC<SessionMCPStatusProps> = ({ tabId }) => {
  const [servers, setServers] = useState<SessionMcpServerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());

  const loadStatus = useCallback(async () => {
    try {
      const result = await api.sessionMcpServerStatus(tabId);
      setServers(result ?? []);
      return (result ?? []).length > 0;
    } catch (err) {
      console.error("[SessionMCPStatus] Failed to load MCP server status:", err);
      return false;
    } finally {
      setLoading(false);
    }
  }, [tabId]);

  // Poll for MCP status while the panel is open and no servers have been
  // reported yet. The SDK's control channel doesn't reply until the CLI has
  // processed its first stdin message, so opening this panel right after a
  // Start click would otherwise land on an empty list and stay there even
  // after the user sends their first prompt. Polling ends as soon as we get
  // a non-empty result or the panel unmounts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      while (!cancelled) {
        const ok = await loadStatus();
        if (ok || cancelled) return;
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadStatus]);

  const toggleExpanded = (name: string) => {
    setExpandedServers(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  if (servers.length === 0) {
    return (
      <div className="p-6 text-center text-muted-foreground text-sm">
        <p>No MCP servers active in this session.</p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setLoading(true); loadStatus(); }}
          className="mt-2"
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Refresh
        </Button>
      </div>
    );
  }

  const groups = groupByScope(servers);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {servers.length} server{servers.length !== 1 ? "s" : ""}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setLoading(true); loadStatus(); }}
          className="h-7 px-2"
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>

      {groups.map(([scopeKey, scopeServers]) => (
        <div key={scopeKey} className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {SCOPE_LABEL[scopeKey] ?? scopeKey}
            </span>
            <span className="text-xs text-muted-foreground">
              ({scopeServers.length})
            </span>
          </div>

          {scopeServers.map((server) => {
            const Icon = STATUS_ICON[server.status] || AlertTriangle;
            const colorClass = STATUS_COLOR[server.status] || "text-muted-foreground";
            const badgeClass = STATUS_BADGE[server.status] || "";
            const isExpanded = expandedServers.has(server.name);
            const toolCount = server.tools?.length ?? 0;
            const cfg = (server.config ?? {}) as {
              command?: string;
              args?: string[];
              env?: Record<string, string>;
              url?: string;
              type?: string;
            };

            return (
              <div
                key={server.name}
                className="rounded-lg border border-border bg-card"
              >
                <button
                  onClick={() => { toggleExpanded(server.name); }}
                  className="w-full flex items-center gap-3 p-3 text-left hover:bg-muted/50 transition-colors rounded-lg"
                >
                  <Icon className={cn("h-4 w-4 shrink-0", colorClass)} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate">{server.name}</span>
                      {server.serverInfo?.version && (
                        <span className="text-xs font-mono text-muted-foreground">
                          v{server.serverInfo.version}
                        </span>
                      )}
                      {cfg.type && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 uppercase">
                          {cfg.type}
                        </Badge>
                      )}
                    </div>
                    {server.serverInfo?.name && server.serverInfo.name !== server.name && (
                      <span className="text-xs text-muted-foreground">
                        {server.serverInfo.name}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0", badgeClass)}>
                      {server.status}
                    </Badge>
                    {toolCount > 0 && (
                      <span className="text-xs text-muted-foreground">{toolCount} tools</span>
                    )}
                    {isExpanded ? (
                      <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </div>
                </button>

                {isExpanded && (
                  <div className="px-3 pb-3 space-y-2 border-t border-border pt-2">
                    {server.error && (
                      <div className="text-xs text-destructive bg-destructive/5 rounded p-2">
                        {server.error}
                      </div>
                    )}
                    <div className="space-y-1">
                      <DetailRow label="Scope" value={SCOPE_LABEL[scopeKey] ?? scopeKey} />
                      {server.serverInfo?.version && (
                        <DetailRow label="Version" value={server.serverInfo.version} mono />
                      )}
                      {cfg.command && (
                        <DetailRow
                          label="Command"
                          value={`${cfg.command} ${(cfg.args ?? []).join(' ')}`.trim()}
                          mono
                        />
                      )}
                      {cfg.url && (
                        <DetailRow label="URL" value={cfg.url} mono />
                      )}
                      {cfg.env && Object.keys(cfg.env).length > 0 && (
                        <DetailRow
                          label="Env"
                          value={Object.keys(cfg.env).join(', ')}
                          mono
                        />
                      )}
                    </div>
                    {toolCount > 0 && (
                      <div>
                        <span className="text-xs font-medium text-muted-foreground mb-1 block">Tools</span>
                        <div className="flex flex-wrap gap-1">
                          {/* eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- value was just .has-checked above. */}
                          {server.tools!.map((tool) => (
                            <Badge
                              key={tool.name}
                              variant="secondary"
                              className="text-[10px] px-1.5 py-0 font-mono"
                              title={tool.description}
                            >
                              {tool.name}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};

const SCOPE_LABEL: Record<string, string> = {
  user: "User",
  project: "Project",
  local: "Local",
  claudeai: "claude.ai",
  managed: "Managed",
  unknown: "Other",
};

const SCOPE_ORDER = ["user", "project", "local", "claudeai", "managed", "unknown"];

function groupByScope(servers: SessionMcpServerStatus[]): [string, SessionMcpServerStatus[]][] {
  const buckets = new Map<string, SessionMcpServerStatus[]>();
  for (const server of servers) {
    const key = server.scope ?? "unknown";
    const list = buckets.get(key) ?? [];
    list.push(server);
    buckets.set(key, list);
  }
  const keys = Array.from(buckets.keys()).sort((a, b) => {
    const ai = SCOPE_ORDER.indexOf(a);
    const bi = SCOPE_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- value was just .has-checked above.
  return keys.map((k) => [k, buckets.get(k)!.slice().sort((a, b) => a.name.localeCompare(b.name))]);
}

const DetailRow: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="text-xs flex gap-2">
    <span className="text-muted-foreground shrink-0">{label}:</span>
    <span className={cn("min-w-0 break-all", mono && "font-mono")}>{value}</span>
  </div>
);
