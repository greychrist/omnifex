import * as React from "react";
import { Bot, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { TooltipSimple } from "@/components/ui/tooltip-modern";
import { HeaderLabel } from "@/components/HeaderLabel";
import type { AgentKind } from "@/lib/api";

export interface AgentBadgeProps {
  /** Which engine drives the current session — drives icon, label, tooltip. */
  agent: AgentKind;
  /**
   * Optional click handler. When provided, the badge renders as a `<button>`
   * with the existing border/shadow chrome and is clickable. When omitted,
   * the badge is a non-interactive `<div>` (used for Codex tabs in Task 23 —
   * the badge is informational only because there's no account picker to
   * open). The wrapper component (e.g. `AgentSession`'s header) is
   * responsible for gating the handler on `conversationStatus`.
   */
  onClick?: () => void;
  /**
   * Disables the click target. Wired by the caller from the same in-flight
   * predicate that gates the account picker. Ignored when `onClick` is
   * absent — a non-interactive badge has nothing to disable.
   */
  disabled?: boolean;
  className?: string;
}

const AGENT_META: Record<AgentKind, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  claude: { label: 'Claude', icon: Bot },
  codex: { label: 'Codex', icon: Sparkles },
};

/**
 * Small "agent" chip rendered in the session header next to the account
 * card. Mirrors the visual rhythm of `AccountCard` / `GitBranchBadge`
 * (rounded-md, `bg-background/40`, the shared border-shadow stack) so the
 * header reads as a single instrument cluster.
 *
 * Two render modes:
 *   - Interactive (`onClick` provided): a `<button>` that opens whatever
 *     the caller wires up — today that's `AccountPickerDialog` for Claude
 *     tabs, since the account picker is the only way to change agents.
 *   - Static (no `onClick`): a `<div>`, used for Codex tabs where the
 *     badge is purely informational.
 *
 * The tooltip text always shows the full agent name so a user hovering
 * over the chip can confirm engine identity without parsing the icon.
 */
export const AgentBadge: React.FC<AgentBadgeProps> = ({
  agent,
  onClick,
  disabled = false,
  className,
}) => {
  const { label, icon: Icon } = AGENT_META[agent];

  const innerBadge = (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border border-foreground/15 bg-background/60 px-2 py-0.5 font-medium whitespace-nowrap text-[11px] text-foreground/90",
      )}
    >
      <Icon className="h-[14px] w-[14px]" />
      {label}
    </span>
  );

  const containerClass = cn(
    "flex flex-col items-start gap-0.5 rounded-md border-0 bg-background/40 px-2 py-1 shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent),2px_2px_4px_rgb(0_0_0/0.08)]",
    className,
  );

  if (onClick) {
    return (
      <TooltipSimple content={label} side="bottom">
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className={cn(
            containerClass,
            "transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            disabled ? "opacity-60 cursor-not-allowed" : "hover:opacity-80 cursor-pointer",
          )}
        >
          <HeaderLabel>agent</HeaderLabel>
          {innerBadge}
        </button>
      </TooltipSimple>
    );
  }

  return (
    <TooltipSimple content={label} side="bottom">
      <div className={containerClass} aria-label={label}>
        <HeaderLabel>agent</HeaderLabel>
        {innerBadge}
      </div>
    </TooltipSimple>
  );
};
