import React, { useState, useEffect, useCallback } from "react";
import { Package, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { api, type SessionPluginInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

interface SessionPluginStatusProps {
  tabId: string;
}

const SCOPE_LABEL: Record<SessionPluginInfo["scope"], string> = {
  user: "User",
  project: "Project",
  local: "Local",
  unknown: "Other",
};

const SCOPE_ORDER: SessionPluginInfo["scope"][] = ["user", "project", "local", "unknown"];

function groupByScope(plugins: SessionPluginInfo[]): [SessionPluginInfo["scope"], SessionPluginInfo[]][] {
  const buckets = new Map<SessionPluginInfo["scope"], SessionPluginInfo[]>();
  for (const p of plugins) {
    const list = buckets.get(p.scope) ?? [];
    list.push(p);
    buckets.set(p.scope, list);
  }
  return SCOPE_ORDER
    .filter((k) => buckets.has(k))
    .map((k) => [k, buckets.get(k)!.slice().sort((a, b) => a.name.localeCompare(b.name))]);
}

export const SessionPluginStatus: React.FC<SessionPluginStatusProps> = ({ tabId }) => {
  const [plugins, setPlugins] = useState<SessionPluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async (force = false) => {
    try {
      const result = await api.sessionPlugins(tabId, force);
      setPlugins(result ?? []);
    } catch (err) {
      console.error("[SessionPluginStatus] Failed to load plugins:", err);
    } finally {
      setLoading(false);
    }
  }, [tabId]);

  useEffect(() => {
    load(false);
  }, [load]);

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleRefresh = () => {
    setLoading(true);
    load(true);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  if (plugins.length === 0) {
    return (
      <div className="p-6 text-center text-muted-foreground text-sm">
        <p>No plugins loaded in this session.</p>
        <Button variant="ghost" size="sm" onClick={handleRefresh} className="mt-2">
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Reload
        </Button>
      </div>
    );
  }

  const groups = groupByScope(plugins);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {plugins.length} plugin{plugins.length !== 1 ? "s" : ""}
        </span>
        <Button variant="ghost" size="sm" onClick={handleRefresh} className="h-7 px-2">
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>

      {groups.map(([scopeKey, scopePlugins]) => (
        <div key={scopeKey} className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {SCOPE_LABEL[scopeKey]}
            </span>
            <span className="text-xs text-muted-foreground">({scopePlugins.length})</span>
          </div>

          {scopePlugins.map((plugin) => {
            const key = `${plugin.scope}:${plugin.name}:${plugin.path}`;
            const isExpanded = expanded.has(key);

            return (
              <div key={key} className="rounded-lg border border-border bg-card">
                <button
                  onClick={() => toggle(key)}
                  className="w-full flex items-center gap-3 p-3 text-left hover:bg-muted/50 transition-colors rounded-lg"
                >
                  <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate">{plugin.name}</span>
                      {plugin.version && (
                        <span className="text-xs font-mono text-muted-foreground">
                          v{plugin.version}
                        </span>
                      )}
                      {plugin.source && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                          {plugin.source}
                        </Badge>
                      )}
                    </div>
                    {plugin.description && (
                      <span className="text-xs text-muted-foreground line-clamp-1">
                        {plugin.description}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {isExpanded ? (
                      <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </div>
                </button>

                {isExpanded && (
                  <div className="px-3 pb-3 space-y-1 border-t border-border pt-2">
                    <DetailRow label="Scope" value={SCOPE_LABEL[plugin.scope]} />
                    {plugin.version && <DetailRow label="Version" value={plugin.version} mono />}
                    {plugin.author && (
                      <DetailRow
                        label="Author"
                        value={plugin.authorEmail ? `${plugin.author} <${plugin.authorEmail}>` : plugin.author}
                      />
                    )}
                    {plugin.source && <DetailRow label="Marketplace" value={plugin.source} />}
                    <DetailRow label="Path" value={plugin.path} mono />
                    {plugin.description && (
                      <DetailRow label="Description" value={plugin.description} />
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

const DetailRow: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="text-xs flex gap-2">
    <span className="text-muted-foreground shrink-0">{label}:</span>
    <span className={cn("min-w-0 break-all", mono && "font-mono")}>{value}</span>
  </div>
);
