import * as React from "react";
import { ChevronRight, RefreshCw, Puzzle } from "lucide-react";
import type { SessionPluginInfo } from "@/lib/api";
import { MOD_CAPABILITY_LABEL } from "@/lib/mods";
import { splitPlugins } from "@/lib/sessionLoadout";
import { SessionPluginStatus, DetailRow } from "@/components/SessionPluginStatus";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

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
  onRefreshPlugins: () => void;
  /** Each mod's pinned `$.ui.status` line, by plugin name. */
  modStatus: Record<string, string>;
  mcpCount: number | null;
  mcp: React.ReactNode;
  instructions: React.ReactNode;
}

export function SessionContextPanel({
  plugins,
  onRefreshPlugins,
  modStatus,
  mcpCount,
  mcp,
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
    <div className="h-full overflow-y-auto divide-y divide-border">
      <Section id="mods" title="Mods" count={split?.mods.length ?? null} open={open.mods} onToggle={toggle}>
        {split ? <ModList mods={split.mods} status={modStatus} /> : loading}
      </Section>
      <Section
        id="plugins"
        title="Plugins"
        count={split?.plugins.length ?? null}
        open={open.plugins}
        onToggle={toggle}
        action={
          <button
            type="button"
            onClick={onRefreshPlugins}
            aria-label="Reload plugins"
            title="Reload plugins. Re-runs each mod's session start."
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        }
      >
        {split ? <SessionPluginStatus plugins={split.plugins} /> : loading}
      </Section>
      <Section id="mcp" title="MCP servers" count={mcpCount} open={open.mcp} onToggle={toggle} flush>
        {mcp}
      </Section>
      <Section id="instructions" title="Instructions" count={null} open={open.instructions} onToggle={toggle} flush>
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
  action,
  flush = false,
  children,
}: {
  id: SectionKey;
  title: string;
  count: number | null;
  open: boolean;
  onToggle: (key: SectionKey) => void;
  action?: React.ReactNode;
  /** The body brings its own padding (the MCP and ledger panels do). */
  flush?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const headerId = `session-context-${id}`;
  return (
    <section role="region" aria-labelledby={headerId}>
      <div className="flex items-center gap-2 px-4 py-2">
        <button
          type="button"
          id={headerId}
          onClick={() => { onToggle(id); }}
          aria-expanded={open}
          className="flex flex-1 items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
          <span>{title}</span>
          {count !== null && <span className="font-mono normal-case text-foreground/60">{count}</span>}
        </button>
        {action}
      </div>
      {open && <div className={flush ? undefined : "px-4 pb-4"}>{children}</div>}
    </section>
  );
}

function ModList({ mods, status }: { mods: SessionPluginInfo[]; status: Record<string, string> }): React.JSX.Element {
  const [expanded, setExpanded] = React.useState<string | null>(null);
  if (mods.length === 0) {
    return <p className="px-1 text-xs text-muted-foreground">No mods loaded in this session.</p>;
  }
  return (
    <div className="space-y-2">
      {mods.map((m) => {
        const inspection = m.mod?.inspection ?? null;
        const isOpen = expanded === m.path;
        const line = status[m.name];
        return (
          <div key={m.path} className="rounded-lg border border-border bg-card">
            <button
              type="button"
              onClick={() => { setExpanded(isOpen ? null : m.path); }}
              aria-expanded={isOpen}
              className="w-full flex items-start gap-3 p-3 text-left hover:bg-muted/50 transition-colors rounded-lg"
            >
              <Puzzle className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium truncate">{m.name}</span>
                  {m.version && <span className="text-xs font-mono text-muted-foreground">v{m.version}</span>}
                </div>
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
                  <span className="block text-xs text-muted-foreground italic">Could not read what this mod does.</span>
                )}
                {line && <span className="block text-xs font-mono text-foreground/80 break-words">{line}</span>}
              </div>
            </button>
            {isOpen && (
              <div className="px-3 pb-3 space-y-1 border-t border-border pt-2">
                {inspection && <CodeList label="Hooks" items={inspection.hooks} />}
                {inspection && <CodeList label="Calls" items={inspection.calls} />}
                {m.source && <DetailRow label="Marketplace" value={m.source} />}
                <DetailRow label="Path" value={m.path} mono />
              </div>
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
    <div className="text-xs">
      <span className="text-muted-foreground">{label}:</span>
      <ul className="mt-0.5 ml-3 space-y-0.5">
        {items.map((item) => (
          <li key={item} className="font-mono break-all">{item}</li>
        ))}
      </ul>
    </div>
  );
}
