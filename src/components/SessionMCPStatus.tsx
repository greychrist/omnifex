import React, { useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import type { SessionMcpServerStatus } from "@/lib/api";
import {
  DetailBlock, DetailRow, EmptyLine, GroupHeader, RowTag, StatusDot, rowClass, scopeIcon, useCollapsedGroups,
} from "@/components/sessionContext/rows";

/**
 * The MCP servers section of the Session context panel. Presentational: the
 * list comes from useSessionMcpStatus, because the section heading counts it
 * too and must not wait for this section to be opened.
 */
interface SessionMCPStatusProps {
  /** Null while the list is being fetched. */
  servers: SessionMcpServerStatus[] | null;
}

const STATUS_DOT: Record<string, string> = {
  connected: "bg-emerald-400",
  failed: "bg-destructive",
  "needs-auth": "bg-yellow-500",
  pending: "bg-muted-foreground/60 animate-pulse",
  disabled: "bg-muted-foreground/40",
};

export const SessionMCPStatus: React.FC<SessionMCPStatusProps> = ({ servers }) => {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [collapsed, toggleGroup] = useCollapsedGroups();

  if (servers === null) {
    return (
      <div className="flex justify-center py-3">
        <Spinner className="size-4 text-muted-foreground" />
      </div>
    );
  }

  if (servers.length === 0) {
    return <EmptyLine>No MCP servers active in this session.</EmptyLine>;
  }

  return (
    <div className="p-2">
      {groupByScope(servers).map(([scopeKey, scopeServers]) => {
        const groupOpen = !collapsed.has(scopeKey);
        return (
          <div key={scopeKey} className="mb-1">
            <GroupHeader
              label={SCOPE_LABEL[scopeKey] ?? scopeKey}
              icon={scopeIcon(scopeKey)}
              count={scopeServers.length}
              open={groupOpen}
              onToggle={() => { toggleGroup(scopeKey); }}
            />
            {groupOpen && (
              <ul className="mt-0.5">
                {scopeServers.map((server) => {
                  const isOpen = expanded === server.name;
                  const toolCount = server.tools?.length ?? 0;
                  const cfg = (server.config ?? {}) as {
                    command?: string;
                    args?: string[];
                    env?: Record<string, string>;
                    url?: string;
                    type?: string;
                  };
                  return (
                    <li key={server.name} className="flex flex-col">
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() => { setExpanded(isOpen ? null : server.name); }}
                        className={rowClass(true)}
                      >
                        <StatusDot className={STATUS_DOT[server.status] ?? "bg-yellow-500"} label={server.status} />
                        <span className="truncate">{server.name}</span>
                        {cfg.type && <RowTag>{cfg.type}</RowTag>}
                        <span className="ml-auto flex-none tabular-nums text-[10px] text-muted-foreground/70">
                          {server.status === "connected" ? (toolCount > 0 ? `${toolCount} tools` : "") : server.status}
                        </span>
                      </button>
                      {isOpen && (
                        <DetailBlock>
                          {server.error && (
                            <div className="rounded bg-destructive/5 p-1.5 text-destructive">{server.error}</div>
                          )}
                          {server.serverInfo?.version && (
                            <DetailRow label="Version" value={server.serverInfo.version} mono />
                          )}
                          {cfg.command && (
                            <DetailRow label="Command" value={`${cfg.command} ${(cfg.args ?? []).join(" ")}`.trim()} mono />
                          )}
                          {cfg.url && <DetailRow label="URL" value={cfg.url} mono />}
                          {cfg.env && Object.keys(cfg.env).length > 0 && (
                            <DetailRow label="Env" value={Object.keys(cfg.env).join(", ")} mono />
                          )}
                          {toolCount > 0 && (
                            <div className="flex flex-wrap gap-1 pt-0.5">
                              {/* eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- toolCount > 0 above. */}
                              {server.tools!.map((tool) => (
                                <span
                                  key={tool.name}
                                  title={tool.description}
                                  className="rounded-sm bg-foreground/5 px-1.5 py-0.5 font-mono text-[10px] text-foreground/70"
                                >
                                  {tool.name}
                                </span>
                              ))}
                            </div>
                          )}
                        </DetailBlock>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
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
