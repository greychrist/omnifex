import * as React from "react";
import { cn } from "@/lib/utils";
import { TooltipSimple } from "@/components/ui/tooltip-modern";
import { BrandIcon } from "@/components/shared/BrandIcon";
import type { AgentKind } from "@/lib/api";

export interface AgentBadgeProps {
  /** Which engine drives the current session — drives icon, label, tooltip. */
  agent: AgentKind;
  /**
   * Optional click handler. When provided, the badge renders as a `<button>`
   * (used for Claude tabs to open the account picker). When omitted, it
   * renders as a non-interactive `<span>` (Codex tabs — informational only).
   */
  onClick?: () => void;
  /** Disables the click target. Ignored when `onClick` is absent. */
  disabled?: boolean;
  className?: string;
}

const AGENT_LABELS: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "OpenAI Codex",
};

/**
 * Minimal agent indicator in the session header — just the brand mark, no
 * surrounding card or "agent" label. Hovering shows the engine name; click
 * opens the account picker (Claude tabs only).
 */
export const AgentBadge: React.FC<AgentBadgeProps> = ({
  agent,
  onClick,
  disabled = false,
  className,
}) => {
  const label = AGENT_LABELS[agent];
  const icon = <BrandIcon agent={agent} className="h-5 w-5" ariaLabel={label} />;
  const base = "inline-flex items-center justify-center text-foreground/80";

  if (onClick) {
    return (
      <TooltipSimple content={label} side="bottom">
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className={cn(
            base,
            "transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded",
            disabled ? "opacity-60 cursor-not-allowed" : "hover:text-foreground cursor-pointer",
            className,
          )}
        >
          {icon}
        </button>
      </TooltipSimple>
    );
  }

  return (
    <TooltipSimple content={label} side="bottom">
      <span className={cn(base, className)} aria-label={label}>
        {icon}
      </span>
    </TooltipSimple>
  );
};
