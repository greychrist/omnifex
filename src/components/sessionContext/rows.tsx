import * as React from "react";
import { ChevronRight, User, FolderGit2, HardDrive, Box, Cloud, Building2, CircleHelp } from "lucide-react";
import { cn } from "@/lib/utils";

// 30px lands a row's label under its heading's label (42px minus the 12px dot and gap). Padding, not margin, so the hover spans the full width.
export const ROW_INDENT = "pl-[30px]";
export const CONTENT_INDENT = "ml-[30px]";

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

export function StatusDot({ className, label }: { className: string; label: string }): React.JSX.Element {
  return <span aria-label={label} className={cn("h-1.5 w-1.5 flex-none rounded-full", className)} />;
}

export function RowTag({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="min-w-0 truncate rounded bg-muted px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

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

export function EmptyLine({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="px-1.5 py-1 text-[11px] text-muted-foreground">{children}</p>;
}

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
