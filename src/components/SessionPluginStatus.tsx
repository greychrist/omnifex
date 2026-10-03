import React, { useState } from "react";
import { Package, ChevronDown, ChevronUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { SessionPluginInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * The Plugins section of the Session context panel: the session's plugins,
 * grouped by where they were installed. Presentational — the panel owns the
 * list (useSessionPlugins), because the Mods section reads the same one.
 */
interface SessionPluginStatusProps {
  plugins: SessionPluginInfo[];
}

const SCOPE_LABEL: Record<SessionPluginInfo["scope"], string> = {
  user: "User",
  project: "Project",
  local: "Local",
  builtin: "Built in",
  unknown: "Other",
};

const SCOPE_ORDER: SessionPluginInfo["scope"][] = ["user", "project", "local", "builtin", "unknown"];

function groupByScope(plugins: SessionPluginInfo[]): [SessionPluginInfo["scope"], SessionPluginInfo[]][] {
  const buckets = new Map<SessionPluginInfo["scope"], SessionPluginInfo[]>();
  for (const p of plugins) {
    const list = buckets.get(p.scope) ?? [];
    list.push(p);
    buckets.set(p.scope, list);
  }
  return SCOPE_ORDER
    .filter((k) => buckets.has(k))
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- value was just .has-checked above.
    .map((k) => [k, buckets.get(k)!.slice().sort((a, b) => a.name.localeCompare(b.name))]);
}

export const SessionPluginStatus: React.FC<SessionPluginStatusProps> = ({ plugins }) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (plugins.length === 0) {
    return <p className="px-1 text-xs text-muted-foreground">No plugins loaded in this session.</p>;
  }

  const groups = groupByScope(plugins);

  return (
    <div className="space-y-4">
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
                  onClick={() => { toggle(key); }}
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
                    {plugin.scope !== "builtin" && <DetailRow label="Path" value={plugin.path} mono />}
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

export const DetailRow: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="text-xs flex gap-2">
    <span className="text-muted-foreground shrink-0">{label}:</span>
    <span className={cn("min-w-0 break-all", mono && "font-mono")}>{value}</span>
  </div>
);
