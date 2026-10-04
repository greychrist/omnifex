import * as React from "react";
import { ChevronsUpDown, RefreshCw } from "lucide-react";
import type { SessionPluginInfo } from "@/lib/api";
import { MOD_CAPABILITY_LABEL } from "@/lib/mods";
import { splitPlugins } from "@/lib/sessionLoadout";
import { SessionPluginStatus, SCOPE_LABEL, groupByScope, marketplaceOf } from "@/components/SessionPluginStatus";
import {
  CONTENT_INDENT, DetailBlock, DetailRow, EmptyLine, GroupHeader, StatusDot, rowClass, scopeIcon, useCollapsedGroups,
} from "@/components/sessionContext/rows";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { SURFACE_HEADER } from "@/lib/surfaceStyles";

/**
 * "What is shaping this session?" — one side panel, four sections: the mods
 * running inside the CLI, the plugins it loaded, its MCP servers, and the
 * instructions that reached it (the context ledger).
 *
 * These were three panels behind three header buttons (MCP, Plugins, Session
 * context). They answer one question from mostly one source — system:init —
 * so they are read together. Inspector and Permissions stay apart: one is
 * diagnostics, the other an editor.
 *
 * Mods lead. They are plugins, but the one kind that runs code inside the
 * CLI, and in a stream-json session nothing they draw reaches OmniFex — so
 * this is the only place a mod that approves tool calls is visible at all.
 */

type SectionKey = "mods" | "plugins" | "mcp" | "instructions";

const SECTIONS_STORAGE_KEY = "omnifex.sessionContext.sections";
// All collapsed: the headers and their counts are the overview, and the panel
// remembers whichever you open.
const DEFAULT_OPEN: Record<SectionKey, boolean> = { mods: false, plugins: false, mcp: false, instructions: false };

function readOpen(): Record<SectionKey, boolean> {
  try {
    const saved = JSON.parse(localStorage.getItem(SECTIONS_STORAGE_KEY) ?? "{}") as Partial<Record<SectionKey, boolean>>;
    return { ...DEFAULT_OPEN, ...saved };
  } catch {
    return DEFAULT_OPEN;
  }
}

export interface SessionContextPanelProps {
  /** Null while the list is being fetched. */
  plugins: SessionPluginInfo[] | null;
  /** Each mod's pinned `$.ui.status` line, by plugin name. */
  modStatus: Record<string, string>;
  /** Null while unknown, which leaves the heading without a count. */
  mcpCount: number | null;
  mcp: React.ReactNode;
  /** Entries in the context ledger; null when the session has no record. */
  instructionsCount: number | null;
  instructions: React.ReactNode;
}

export function SessionContextPanel({
  plugins,
  modStatus,
  mcpCount,
  mcp,
  instructionsCount,
  instructions,
}: SessionContextPanelProps): React.JSX.Element {
  const [open, setOpen] = React.useState(readOpen);
  const toggle = (key: SectionKey) => {
    setOpen((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  const split = plugins ? splitPlugins(plugins) : null;
  const loading = (
    <div className="flex justify-center py-3">
      <Spinner className="size-4 text-muted-foreground" />
    </div>
  );

  return (
    <div className="h-full overflow-y-auto">
      <Section id="mods" title="Mods" count={split?.mods.length ?? null} open={open.mods} onToggle={toggle}>
        {split ? <ModList mods={split.mods} status={modStatus} /> : loading}
      </Section>
      <Section id="plugins" title="Plugins" count={split?.plugins.length ?? null} open={open.plugins} onToggle={toggle}>
        {split ? <SessionPluginStatus plugins={split.plugins} /> : loading}
      </Section>
      <Section id="mcp" title="MCP servers" count={mcpCount} open={open.mcp} onToggle={toggle}>
        {mcp}
      </Section>
      <Section id="instructions" title="Instructions" count={instructionsCount} open={open.instructions} onToggle={toggle}>
        {instructions}
      </Section>
    </div>
  );
}

function Section({
  id,
  title,
  count,
  open,
  onToggle,
  children,
}: {
  id: SectionKey;
  title: string;
  count: number | null;
  open: boolean;
  onToggle: (key: SectionKey) => void;
  /** Brings its own padding: every body is a row list in the rows.tsx grammar. */
  children: React.ReactNode;
}): React.JSX.Element {
  const headerId = `session-context-${id}`;
  return (
    <section role="region" aria-labelledby={headerId}>
      {/* A header band (the Lima card header), ending in the chat cards'
          up/down expander — so it cannot be mistaken for the chevron-led
          scope groups inside it. */}
      <button
        type="button"
        id={headerId}
        onClick={() => { onToggle(id); }}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-foreground/85 transition-colors hover:text-foreground",
          SURFACE_HEADER,
        )}
      >
        <span>{title}</span>
        {count !== null && (
          <span className="font-mono text-[10px] font-normal tabular-nums text-muted-foreground">({count})</span>
        )}
        <ChevronsUpDown aria-hidden="true" className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
      </button>
      {open && <div className="pb-1">{children}</div>}
    </section>
  );
}

/**
 * The panel header's one control: reload plugins (which re-runs each mod's
 * session start) and ask the MCP servers again. It used to be two buttons,
 * one inside Plugins and one inside MCP servers, each visible only with its
 * section open.
 */
export function SessionContextRefreshButton({
  onRefresh,
  busy,
}: {
  onRefresh: () => void;
  busy: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={busy ? undefined : onRefresh}
      aria-busy={busy}
      aria-label="Refresh session context"
      title="Reload plugins and MCP servers. Re-runs each mod's session start."
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background/60 hover:text-foreground"
    >
      <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
    </button>
  );
}

function ModList({ mods, status }: { mods: SessionPluginInfo[]; status: Record<string, string> }): React.JSX.Element {
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [collapsed, toggleGroup] = useCollapsedGroups();
  if (mods.length === 0) {
    return <EmptyLine>No mods loaded in this session.</EmptyLine>;
  }
  return (
    <div className="p-2">
      {groupByScope(mods).map(([scopeKey, scopeMods]) => {
        const groupOpen = !collapsed.has(scopeKey);
        return (
          <div key={scopeKey} className="mb-1">
            <GroupHeader
              label={SCOPE_LABEL[scopeKey]}
              icon={scopeIcon(scopeKey)}
              count={scopeMods.length}
              open={groupOpen}
              onToggle={() => { toggleGroup(scopeKey); }}
            />
            {groupOpen && (
              <ul className="mt-0.5">
                {scopeMods.map((m) => {
                  const inspection = m.mod?.inspection ?? null;
                  const isOpen = expanded === m.path;
                  const line = status[m.name];
                  return (
                    <li key={m.path} className="flex flex-col">
                      <button
                        type="button"
                        onClick={() => { setExpanded(isOpen ? null : m.path); }}
                        aria-expanded={isOpen}
                        className={rowClass(true)}
                      >
                        <StatusDot className="bg-emerald-400" label="loaded" />
                        <span className="truncate">{m.name}</span>
                        {m.version && (
                          <span className="ml-auto flex-none font-mono text-[10px] text-muted-foreground/70">v{m.version}</span>
                        )}
                      </button>
                      {/* What the mod can do stays visible with the row shut:
                          a mod that approves tool calls is the reason this
                          section exists. */}
                      <div className={cn("mb-1 mr-1.5 space-y-1 pl-3", CONTENT_INDENT)}>
                        {inspection ? (
                          inspection.capabilities.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {inspection.capabilities.map((c) => (
                                <span
                                  key={c}
                                  className={cn(
                                    "rounded-sm px-1.5 py-0.5 text-[10px]",
                                    c === "tool-calls" ? "bg-amber-500/15 text-amber-300" : "bg-foreground/5 text-foreground/70",
                                  )}
                                >
                                  {MOD_CAPABILITY_LABEL[c]}
                                </span>
                              ))}
                            </div>
                          )
                        ) : (
                          <span className="block text-[10px] italic text-muted-foreground">Could not read what this mod does.</span>
                        )}
                        {line && <span className="block break-words font-mono text-[10px] text-foreground/80">{line}</span>}
                      </div>
                      {isOpen && (
                        <DetailBlock>
                          {inspection && <CodeList label="Hooks" items={inspection.hooks} />}
                          {inspection && <CodeList label="Calls" items={inspection.calls} />}
                          {marketplaceOf(m) && <DetailRow label="Marketplace" value={marketplaceOf(m) as string} />}
                          <DetailRow label="Path" value={m.path} mono />
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
}

function CodeList({ label, items }: { label: string; items: string[] }): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div>
      <span className="text-muted-foreground">{label}:</span>
      <ul className="mt-0.5 ml-3 space-y-0.5">
        {items.map((item) => (
          <li key={item} className="font-mono break-all">{item}</li>
        ))}
      </ul>
    </div>
  );
}
