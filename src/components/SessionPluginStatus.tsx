import React, { useState } from "react";
import type { SessionPluginInfo } from "@/lib/api";
import {
  DetailBlock, DetailRow, EmptyLine, GroupHeader, RowTag, StatusDot, rowClass, scopeIcon, useCollapsedGroups,
} from "@/components/sessionContext/rows";

/**
 * The Plugins section of the Session context panel: the session's plugins,
 * grouped by where they were installed. Presentational — the panel owns the
 * list (useSessionPlugins), because the Mods section reads the same one.
 */
interface SessionPluginStatusProps {
  plugins: SessionPluginInfo[];
}

export const SCOPE_LABEL: Record<SessionPluginInfo["scope"], string> = {
  user: "User",
  project: "Project",
  local: "Local",
  builtin: "Built in",
  unknown: "Other",
};

const SCOPE_ORDER: SessionPluginInfo["scope"][] = ["user", "project", "local", "builtin", "unknown"];

export function groupByScope(plugins: SessionPluginInfo[]): [SessionPluginInfo["scope"], SessionPluginInfo[]][] {
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

/**
 * The marketplace a plugin came from. The CLI reports `source` as the full
 * `name@marketplace` id, so a tag showing it repeats the name beside itself.
 * Built-ins report `@builtin`, which their group heading already says.
 */
export function marketplaceOf(plugin: SessionPluginInfo): string | null {
  if (!plugin.source || plugin.scope === "builtin") return null;
  const at = plugin.source.lastIndexOf("@");
  return at === -1 ? plugin.source : plugin.source.slice(at + 1) || null;
}

export const SessionPluginStatus: React.FC<SessionPluginStatusProps> = ({ plugins }) => {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [collapsed, toggleGroup] = useCollapsedGroups();

  if (plugins.length === 0) {
    return <EmptyLine>No plugins loaded in this session.</EmptyLine>;
  }

  return (
    <div className="p-2">
      {groupByScope(plugins).map(([scopeKey, scopePlugins]) => {
        const open = !collapsed.has(scopeKey);
        return (
          <div key={scopeKey} className="mb-1">
            <GroupHeader
              label={SCOPE_LABEL[scopeKey]}
              icon={scopeIcon(scopeKey)}
              count={scopePlugins.length}
              open={open}
              onToggle={() => { toggleGroup(scopeKey); }}
            />
            {open && (
              <ul className="mt-0.5">
                {scopePlugins.map((plugin) => {
                  const key = `${plugin.scope}:${plugin.name}:${plugin.path}`;
                  const isOpen = expanded === key;
                  const marketplace = marketplaceOf(plugin);
                  return (
                    <li key={key} className="flex flex-col">
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        title={plugin.description}
                        onClick={() => { setExpanded(isOpen ? null : key); }}
                        className={rowClass(true)}
                      >
                        <StatusDot className="bg-emerald-400" label="loaded" />
                        {/* The name keeps its width; the tag gives way first. */}
                        <span className="max-w-[70%] shrink-0 truncate">{plugin.name}</span>
                        {marketplace && <RowTag>{marketplace}</RowTag>}
                        {plugin.version && (
                          <span className="ml-auto flex-none font-mono text-[10px] text-muted-foreground/70">
                            v{plugin.version}
                          </span>
                        )}
                      </button>
                      {isOpen && (
                        <DetailBlock>
                          {plugin.description && <p className="text-muted-foreground">{plugin.description}</p>}
                          {plugin.version && <DetailRow label="Version" value={plugin.version} mono />}
                          {plugin.author && (
                            <DetailRow
                              label="Author"
                              value={plugin.authorEmail ? `${plugin.author} <${plugin.authorEmail}>` : plugin.author}
                            />
                          )}
                          {marketplace && <DetailRow label="Marketplace" value={marketplace} />}
                          {plugin.scope !== "builtin" && <DetailRow label="Path" value={plugin.path} mono />}
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
