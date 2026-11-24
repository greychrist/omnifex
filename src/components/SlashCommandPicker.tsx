import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { api, type SlashCommand } from "@/lib/api";
import { localSlashCommands } from "@/lib/localSlashCommands";
import {
  X,
  Command,
  ChevronDown,
  ChevronUp,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { logAndForget } from "@/lib/fireAndLog";

interface SlashCommandPickerProps {
  hasBrainVault?: boolean;
  projectPath?: string;
  tabId?: string;
  prefetchedCommands?: import("@/lib/api").SessionSlashCommand[];
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
  initialQuery?: string;
  className?: string;
  configDir?: string;
}

const SCOPE_LABEL: Record<string, string> = {
  default: "claude",
  project: "project",
  user: "user",
  plugin: "plugin",
  mcp: "mcp",
  omnifex: "omnifex",
};

const SCOPE_COLOR: Record<string, string> = {
  default: "bg-emerald-500/15 text-emerald-400",
  project: "bg-blue-500/15 text-blue-400",
  user: "bg-violet-500/15 text-violet-400",
  plugin: "bg-cyan-500/15 text-cyan-400",
  mcp: "bg-rose-500/15 text-rose-400",
  omnifex: "bg-amber-500/15 text-amber-400",
};

type ScopeFilter = "all" | "project" | "user" | "plugin" | "mcp" | "omnifex" | "default";

// Order matters: it is also the arrow-key cycle order, and the first entry is the initial selection.
const SCOPE_FILTERS: { value: ScopeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "project", label: "Project" },
  { value: "user", label: "User" },
  { value: "plugin", label: "Plugin" },
  { value: "mcp", label: "MCP" },
  { value: "omnifex", label: "OmniFex" },
  { value: "default", label: "Claude" },
];

const cliCommandScope = (name: string): string => {
  if (name.startsWith("mcp__")) return "mcp";
  if (name.includes(":")) return "plugin";
  return "default";
};

const SCOPE_RANK: Record<string, number> = Object.fromEntries(
  SCOPE_FILTERS.filter(f => f.value !== "all").map((f, i) => [f.value, i]),
);
const scopeRank = (scope: string) => SCOPE_RANK[scope] ?? SCOPE_FILTERS.length;

type SortKey = "name" | "scope" | "description";
type SortState = { key: SortKey; dir: "asc" | "desc" } | null;

const SORT_COLUMNS: { key: SortKey; label: string; className: string }[] = [
  { key: "name", label: "Command", className: "w-44" },
  { key: "scope", label: "Type", className: "w-20" },
  { key: "description", label: "Description", className: "" },
];

const compareBy = (key: SortKey, a: SlashCommand, b: SlashCommand): number => {
  if (key === "scope") return scopeRank(a.scope) - scopeRank(b.scope);
  if (key === "description") {
    if (!a.description !== !b.description) return a.description ? -1 : 1;
    return (a.description ?? "").localeCompare(b.description ?? "");
  }
  return a.name.localeCompare(b.name);
};

const toSlashCommands = (sdkCommands: import("@/lib/api").SessionSlashCommand[]): SlashCommand[] =>
  sdkCommands.map(cmd => ({
    id: `${cliCommandScope(cmd.name)}::${cmd.name}`,
    name: cmd.name,
    full_command: `/${cmd.name}`,
    namespace: '',
    scope: cliCommandScope(cmd.name),
    content: '',
    description: cmd.description || '',
    allowed_tools: [] as string[],
    file_path: '',
    has_bash_commands: false,
    has_file_references: false,
    accepts_arguments: !!cmd.argumentHint,
  }));

function deduplicateCommands(
  defaultCommands: SlashCommand[],
  customCommands: SlashCommand[],
): SlashCommand[] {
  const defaultByFullCmd = new Map<string, SlashCommand>();
  for (const cmd of defaultCommands) {
    defaultByFullCmd.set(cmd.full_command, cmd);
  }

  const merged: SlashCommand[] = [];
  const seenFullCmds = new Set<string>();

  for (const cmd of customCommands) {
    seenFullCmds.add(cmd.full_command);
    const defaultCmd = defaultByFullCmd.get(cmd.full_command);
    if (defaultCmd) {
      merged.push({
        ...cmd,
        description: cmd.description || defaultCmd.description,
      });
    } else {
      merged.push(cmd);
    }
  }

  for (const cmd of defaultCommands) {
    if (!seenFullCmds.has(cmd.full_command)) {
      seenFullCmds.add(cmd.full_command);
      merged.push(cmd);
    }
  }

  return merged;
}

export const SlashCommandPicker: React.FC<SlashCommandPickerProps> = ({
  projectPath,
  tabId,
  prefetchedCommands,
  onSelect,
  onClose,
  initialQuery = "",
  className,
  configDir,
  hasBrainVault = false,
}) => {
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>(SCOPE_FILTERS[0].value);
  const [sort, setSort] = useState<SortState>(null);
  const cycleSort = (key: SortKey) => {
    setSort(prev => {
      if (prev?.key !== key) return { key, dir: "asc" };
      return prev.dir === "asc" ? { key, dir: "desc" } : null;
    });
  };

  const commandListRef = useRef<HTMLDivElement>(null);
  // AnimatePresence keeps the picker mounted through its exit, so without this guard Enter re-fires onSelect.
  const isClosedRef = useRef(false);

  const loadCommands = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const customCommands = await api.slashCommandsList(projectPath, configDir);

      // Catalog first: a long-running session's init list misses built-ins added by later CLI updates.
      const defaultByName = new Map<string, SlashCommand>();
      const addDefaults = (cmds: import("@/lib/api").SessionSlashCommand[]) => {
        for (const cmd of toSlashCommands(cmds)) {
          if (!defaultByName.has(cmd.full_command)) defaultByName.set(cmd.full_command, cmd);
        }
      };
      if (configDir) {
        try {
          const catalog = await api.listSupportedCommands(configDir);
          if (catalog?.length) addDefaults(catalog);
        } catch {
          // Catalog fetch failed (binary missing, etc.) — fall through.
        }
      }
      if (tabId) {
        try {
          const sdkCommands = await api.sessionSupportedCommands(tabId);
          if (sdkCommands?.length) addDefaults(sdkCommands);
        } catch {
          // Session may not be ready yet
        }
      }
      if (!defaultByName.size && prefetchedCommands?.length) {
        addDefaults(prefetchedCommands);
      }
      const defaultCommands: SlashCommand[] = [...defaultByName.values()];

      const merged = deduplicateCommands(defaultCommands, customCommands);
      const seen = new Set<string>();
      const unique = merged.filter(cmd => {
        if (seen.has(cmd.full_command)) return false;
        seen.add(cmd.full_command);
        return true;
      });
      setCommands([...unique, ...localSlashCommands({ hasVault: hasBrainVault, hasSession: !!tabId })]);
    } catch (err) {
      console.error("Failed to load slash commands:", err);
      setError(err instanceof Error ? err.message : 'Failed to load commands');
      setCommands([]);
    } finally {
      setIsLoading(false);
    }
  }, [projectPath, configDir, tabId, prefetchedCommands, hasBrainVault]);

  useEffect(() => {
    logAndForget('slash-command-picker:load-commands', loadCommands());
  }, [loadCommands]);

  const visibleFilters = useMemo(() => {
    const present = new Set(commands.map(c => c.scope));
    return SCOPE_FILTERS.filter(f => f.value === "all" || present.has(f.value));
  }, [commands]);
  const visibleFiltersRef = useRef(visibleFilters);
  visibleFiltersRef.current = visibleFilters;

  const filteredCommands = useMemo(() => {
    if (!commands.length) return [];

    const query = searchQuery.toLowerCase();
    const filtered = commands.filter(cmd => {
      if (scopeFilter !== "all" && cmd.scope !== scopeFilter) return false;

      if (!query) return true;
      return (
        cmd.name.toLowerCase().includes(query) ||
        cmd.full_command.toLowerCase().includes(query) ||
        (cmd.namespace?.toLowerCase().includes(query)) ||
        (cmd.description?.toLowerCase().includes(query))
      );
    });

    filtered.sort((a, b) => {
      if (sort) {
        const byColumn = compareBy(sort.key, a, b);
        const tie = byColumn === 0 ? a.name.localeCompare(b.name) : byColumn;
        return sort.dir === "asc" ? tie : -tie;
      }
      // An exact name match first: it is what Enter should pick.
      if (query) {
        const aExact = a.name.toLowerCase() === query;
        const bExact = b.name.toLowerCase() === query;
        if (aExact && !bExact) return -1;
        if (!aExact && bExact) return 1;
      }
      const byScope = scopeRank(a.scope) - scopeRank(b.scope);
      if (byScope !== 0) return byScope;
      if (query) {
        const aStarts = a.name.toLowerCase().startsWith(query);
        const bStarts = b.name.toLowerCase().startsWith(query);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
      }
      return a.name.localeCompare(b.name);
    });

    return filtered;
  }, [searchQuery, commands, scopeFilter, sort]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredCommands]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isClosedRef.current) return;
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          isClosedRef.current = true;
          onClose();
          break;
        case 'Enter':
          e.preventDefault();
          if (filteredCommands.length > 0 && selectedIndex < filteredCommands.length) {
            isClosedRef.current = true;
            onSelect(filteredCommands[selectedIndex]);
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex(prev => Math.max(0, prev - 1));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex(prev => Math.min(filteredCommands.length - 1, prev + 1));
          break;
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault();
          const delta = e.key === 'ArrowRight' ? 1 : -1;
          setScopeFilter(prev => {
            const filters = visibleFiltersRef.current;
            const idx = filters.findIndex(f => f.value === prev);
            const len = filters.length;
            const next = (idx + delta + len) % len;
            return filters[next].value;
          });
          break;
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => { window.removeEventListener('keydown', handleKeyDown); };
  }, [filteredCommands, selectedIndex, onSelect, onClose]);

  useEffect(() => {
    if (commandListRef.current) {
      const el = commandListRef.current.querySelector(`[data-index="${selectedIndex}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  useEffect(() => {
    setSearchQuery(initialQuery);
  }, [initialQuery]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className={cn(
        "absolute bottom-full mb-2 left-0 right-0 z-50",
        "h-[400px]",
        "bg-background border border-border rounded-lg shadow-lg",
        "flex flex-col overflow-hidden",
        className
      )}
    >
      <div className="border-b border-border px-3 py-2 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Command className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Slash Commands</span>
              <span className="text-xs text-muted-foreground">
                ({filteredCommands.length})
              </span>
            </div>
            {searchQuery && (
              <span className="text-xs text-muted-foreground">
                Searching: &ldquo;{searchQuery}&rdquo;
              </span>
            )}
            <div className="flex items-center gap-1 ml-2">
              {visibleFilters.map(f => (
                <button
                  key={f.value}
                  type="button"
                  className={cn(
                    "text-xs px-2 py-0.5 rounded transition-colors",
                    scopeFilter === f.value
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  )}
                  onClick={() => { setScopeFilter(f.value); }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto" ref={commandListRef}>
        {isLoading && (
          <div className="flex items-center justify-center h-full">
            <span className="text-sm text-muted-foreground">Loading commands...</span>
          </div>
        )}

        {error && (
          <div className="flex flex-col items-center justify-center h-full p-4">
            <AlertCircle className="h-8 w-8 text-destructive mb-2" />
            <span className="text-sm text-destructive text-center">{error}</span>
          </div>
        )}

        {!isLoading && !error && filteredCommands.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full">
            <Command className="h-8 w-8 text-muted-foreground mb-2" />
            <span className="text-sm text-muted-foreground">
              {searchQuery ? 'No commands found' : 'No commands available'}
            </span>
          </div>
        )}

        {!isLoading && !error && filteredCommands.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-muted sticky top-0 text-xs text-muted-foreground z-10">
              <tr>
                {SORT_COLUMNS.map(col => {
                  const dir = sort?.key === col.key ? sort.dir : null;
                  return (
                    <th
                      key={col.key}
                      className={cn("text-left px-3 py-1.5 font-medium", col.className)}
                      aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
                    >
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-foreground"
                        // Keep focus in the composer, so typing keeps filtering.
                        onMouseDown={(e) => { e.preventDefault(); }}
                        onClick={() => { cycleSort(col.key); }}
                      >
                        {col.label}
                        {dir === "asc" && <ChevronUp className="h-3 w-3" />}
                        {dir === "desc" && <ChevronDown className="h-3 w-3" />}
                      </button>
                    </th>
                  );
                })}
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {filteredCommands.map((command, index) => {
                const isSelected = index === selectedIndex;
                const isExpanded = expandedId === command.id;

                return (
                  <React.Fragment key={command.id}>
                    <tr
                      data-index={index}
                      className={cn(
                        "cursor-pointer hover:bg-accent transition-colors",
                        isSelected && "bg-accent"
                      )}
                      onMouseEnter={() => { setSelectedIndex(index); }}
                      onClick={() => { onSelect(command); }}
                    >
                      <td className="px-3 py-1.5 font-mono text-xs text-primary whitespace-nowrap">
                        {command.full_command}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className={cn(
                          "text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide",
                          SCOPE_COLOR[command.scope] || "bg-foreground/10 text-foreground/60"
                        )}>
                          {SCOPE_LABEL[command.scope] || command.scope}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground truncate max-w-0">
                        {command.description || "\u2014"}
                      </td>
                      <td className="px-1 py-1.5 text-center">
                        {command.description && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-foreground"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedId(isExpanded ? null : command.id);
                            }}
                          >
                            {isExpanded
                              ? <ChevronUp className="h-4 w-4" />
                              : <ChevronDown className="h-4 w-4" />}
                          </Button>
                        )}
                      </td>
                    </tr>
                    {isExpanded && command.description && (
                      <tr className="bg-muted/20">
                        <td colSpan={4} className="px-3 py-2 text-xs text-muted-foreground leading-relaxed">
                          {command.description}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="border-t border-border p-2 shrink-0">
        <p className="text-xs text-muted-foreground text-center">
          ↑↓ Navigate &bull; ←→ Switch tab &bull; Enter Select &bull; Esc Close
        </p>
      </div>
    </motion.div>
  );
};
