import * as React from "react";
import { ChevronRight, User, FolderGit2, HardDrive, Box, Cloud, Building2, CircleHelp } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The row grammar every Session context section shares: a collapsible group
 * heading (chevron, icon, label, count on the right), compact rows led by a
 * status dot, and details that open inline beneath a row. It started as the
 * Instructions section's layout; Mods, Plugins and MCP servers used to draw
 * big bordered cards instead, and the four sections read as four apps.
 */

/**
 * Left inset for a row, so its label lines up with its group heading's label
 * instead of sitting outboard of the heading's own chevron.
 *
 * Derived from the heading row rather than picked: 6px padding + 12px chevron
 * + 6px gap + 12px icon + 6px gap = 42px to the heading label. A row reaches
 * its label through 6px dot + 6px gap, so it needs 30px of padding to land in
 * the same column. Change the heading's icon or gap and this follows.
 *
 * Applied as padding on the row, not margin on the list, so the hover
 * highlight still spans the panel's full width.
 */
export const ROW_INDENT = "pl-[30px]";
/** The same column, for the expanded content block beneath a row. */
export const CONTENT_INDENT = "ml-[30px]";

/** A row's shell; `clickable` adds the hover and pointer. */
export function rowClass(clickable: boolean): string {
  return cn(
    "flex w-full items-center gap-1.5 rounded py-1 pr-1.5 text-left text-[11px]",
    ROW_INDENT,
    clickable && "cursor-pointer hover:bg-muted/60",
  );
}

export function GroupHeader({
  label,
  icon: Icon,
  count,
  open,
  onToggle,
  testId,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  count: number;
  open: boolean;
  onToggle: () => void;
  testId?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-expanded={open}
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-muted/60"
    >
      <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
      <Icon className="h-3 w-3" />
      <span>{label}</span>
      <span className="ml-auto tabular-nums">{count}</span>
    </button>
  );
}

/** The 6px dot that leads a row; `label` is what a screen reader hears. */
export function StatusDot({ className, label }: { className: string; label: string }): React.JSX.Element {
  return <span aria-label={label} className={cn("h-1.5 w-1.5 flex-none rounded-full", className)} />;
}

/** A small uppercase tag inside a row (a scope, a marketplace, a transport). */
export function RowTag({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="min-w-0 truncate rounded bg-muted px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

/** What opens beneath a row, indented to the row's label column. */
export function DetailBlock({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className={cn("mb-1 mr-1.5 space-y-1 rounded border bg-background p-2 text-[11px]", CONTENT_INDENT)}>
      {children}
    </div>
  );
}

export function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-muted-foreground">{label}:</span>
      <span className={cn("min-w-0 break-all", mono && "font-mono")}>{value}</span>
    </div>
  );
}

/** A section's empty or loading line, set in the row column. */
export function EmptyLine({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="px-1.5 py-1 text-[11px] text-muted-foreground">{children}</p>;
}

/** Plugin and MCP scopes, one icon each, so a group heading reads at a glance. */
const SCOPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  user: User,
  project: FolderGit2,
  local: HardDrive,
  builtin: Box,
  claudeai: Cloud,
  managed: Building2,
};

export function scopeIcon(scope: string): React.ComponentType<{ className?: string }> {
  return SCOPE_ICON[scope] ?? CircleHelp;
}

/** Which groups are collapsed; every group starts open. */
export function useCollapsedGroups(): [Set<string>, (key: string) => void] {
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set());
  const toggle = React.useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  return [collapsed, toggle];
}
