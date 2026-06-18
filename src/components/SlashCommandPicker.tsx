import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { api, type SlashCommand } from "@/lib/api";
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
  // Per-row badge for CLI-sourced commands. The scope value stays "default"
  // (that's the CLI's own term) but we surface it to the user as "claude".
  default: "claude",
  project: "project",
  user: "user",
};

const SCOPE_COLOR: Record<string, string> = {
  default: "bg-emerald-500/15 text-emerald-400",
  project: "bg-blue-500/15 text-blue-400",
  user: "bg-violet-500/15 text-violet-400",
};

type ScopeFilter = "project" | "user" | "default" | "all";

// Order matters: tab order is also the left/right-arrow cycle order, and the
// first entry is the initial selection on open. "All" leads so the picker
// opens showing every scope by default.
const SCOPE_FILTERS: { value: ScopeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "project", label: "Project" },
  { value: "user", label: "User" },
  { value: "default", label: "Claude" },
];

const DESCRIPTION_PREVIEW_LENGTH = 60;

const toSlashCommands = (sdkCommands: import("@/lib/api").SessionSlashCommand[]): SlashCommand[] =>
  sdkCommands.map(cmd => ({
    id: `default::${cmd.name}`,
    name: cmd.name,
    full_command: `/${cmd.name}`,
    namespace: '',
    scope: 'default' as const,
    content: '',
    description: cmd.description || '',
    allowed_tools: [] as string[],
    file_path: '',
    has_bash_commands: false,
    has_file_references: false,
    accepts_arguments: !!cmd.argumentHint,
  }));

/**
 * Merge default and custom command lists. When a command name appears in both,
 * keep a single entry with the project/user scope but fall back to the default
 * description when the custom one is empty.
 */
function deduplicateCommands(
  defaultCommands: SlashCommand[],
  customCommands: SlashCommand[],
): SlashCommand[] {
  // Index defaults by full_command for exact match
  const defaultByFullCmd = new Map<string, SlashCommand>();
  for (const cmd of defaultCommands) {
    defaultByFullCmd.set(cmd.full_command, cmd);
  }

  const merged: SlashCommand[] = [];
  const seenFullCmds = new Set<string>();

  // Custom commands take priority — merge in default description if needed
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

  // Add default-only commands (not already covered by custom)
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
}) => {
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>(SCOPE_FILTERS[0].value);

  const commandListRef = useRef<HTMLDivElement>(null);
  // Set once a selection or close has fired. AnimatePresence (in the parent)
  // keeps the picker mounted during its exit animation, so without this guard
  // the window-level keydown listener would re-fire onSelect when the user
  // presses Enter again to send the picked command — repopulating the textarea
  // after the send and forcing a second Enter to clear it.
  const isClosedRef = useRef(false);

  const loadCommands = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const customCommands = await api.slashCommandsList(projectPath, configDir);

      let defaultCommands: SlashCommand[] = [];
      if (tabId) {
        try {
          const sdkCommands = await api.sessionSupportedCommands(tabId);
          if (sdkCommands?.length) {
            defaultCommands = toSlashCommands(sdkCommands);
          }
        } catch {
          // Session may not be ready yet
        }
      }
      if (!defaultCommands.length && prefetchedCommands?.length) {
        defaultCommands = toSlashCommands(prefetchedCommands);
      }

      const merged = deduplicateCommands(defaultCommands, customCommands);
      // Final safety: deduplicate by full_command in case any slip through
      const seen = new Set<string>();
      const unique = merged.filter(cmd => {
        if (seen.has(cmd.full_command)) return false;
        seen.add(cmd.full_command);
        return true;
      });
      setCommands(unique);
    } catch (err) {
      console.error("Failed to load slash commands:", err);
      setError(err instanceof Error ? err.message : 'Failed to load commands');
      setCommands([]);
    } finally {
      setIsLoading(false);
    }
  }, [projectPath, configDir, tabId, prefetchedCommands]);

  // Load commands on mount (re-runs when the loadCommands callback changes,
  // i.e. when projectPath, configDir, tabId, or prefetchedCommands change).
  useEffect(() => {
    logAndForget('slash-command-picker:load-commands', loadCommands());
  }, [loadCommands]);

  // Filter + sort
  const filteredCommands = useMemo(() => {
    if (!commands.length) return [];

    const query = searchQuery.toLowerCase();
    const filtered = commands.filter(cmd => {
      // Scope filter — "all" passes everything; the others require an exact match.
      if (scopeFilter !== "all" && cmd.scope !== scopeFilter) return false;

      // Text search
      if (!query) return true;
      return (
        cmd.name.toLowerCase().includes(query) ||
        cmd.full_command.toLowerCase().includes(query) ||
        (cmd.namespace?.toLowerCase().includes(query)) ||
        (cmd.description?.toLowerCase().includes(query))
      );
    });

    filtered.sort((a, b) => {
      if (query) {
        const aExact = a.name.toLowerCase() === query;
        const bExact = b.name.toLowerCase() === query;
        if (aExact && !bExact) return -1;
        if (!aExact && bExact) return 1;
        const aStarts = a.name.toLowerCase().startsWith(query);
        const bStarts = b.name.toLowerCase().startsWith(query);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
      }
      return a.name.localeCompare(b.name);
    });

    return filtered;
  }, [searchQuery, commands, scopeFilter]);

  // Reset selection when list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredCommands]);

  // Keyboard navigation
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
            const idx = SCOPE_FILTERS.findIndex(f => f.value === prev);
            const len = SCOPE_FILTERS.length;
            // Wrap on both ends so the cycle is continuous.
            const next = (idx + delta + len) % len;
            return SCOPE_FILTERS[next].value;
          });
          break;
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => { window.removeEventListener('keydown', handleKeyDown); };
  }, [filteredCommands, selectedIndex, onSelect, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    if (commandListRef.current) {
      const el = commandListRef.current.querySelector(`[data-index="${selectedIndex}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  // Update search query from parent
  useEffect(() => {
    setSearchQuery(initialQuery);
  }, [initialQuery]);

  const truncateDescription = (desc: string) => {
    if (desc.length <= DESCRIPTION_PREVIEW_LENGTH) return desc;
    return desc.slice(0, DESCRIPTION_PREVIEW_LENGTH).trimEnd() + "...";
  };

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
      {/* Header */}
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
              {SCOPE_FILTERS.map(f => (
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

      {/* Command List */}
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
                <th className="text-left px-3 py-1.5 font-medium w-44">Command</th>
                <th className="text-left px-3 py-1.5 font-medium w-20">Type</th>
                <th className="text-left px-3 py-1.5 font-medium">Description</th>
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
                      <td className="px-3 py-1.5 font-mono text-primary whitespace-nowrap">
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
                        {command.description
                          ? truncateDescription(command.description)
                          : "\u2014"}
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

      {/* Footer */}
      <div className="border-t border-border p-2 shrink-0">
        <p className="text-xs text-muted-foreground text-center">
          ↑↓ Navigate &bull; ←→ Switch tab &bull; Enter Select &bull; Esc Close
        </p>
      </div>
    </motion.div>
  );
};
