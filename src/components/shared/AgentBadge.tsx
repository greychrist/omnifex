import * as React from "react";
import { cn } from "@/lib/utils";
import { TooltipSimple } from "@/components/ui/tooltip-modern";
import { BrandIcon } from "@/components/shared/BrandIcon";
import type { AgentKind } from "@/lib/api";

export interface AgentBadgeProps {
  agent: AgentKind;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}

const AGENT_LABELS: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "OpenAI Codex",
};

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
