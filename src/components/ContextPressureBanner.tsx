import React from "react";
import { AlertTriangle, AlertOctagon } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTokens, type ContextPressure } from "@/lib/contextPressure";

export interface ContextPressureBannerProps {
  /** Level drives the render; `none` renders nothing. */
  pressure: ContextPressure;
  /** Current context occupancy in tokens. */
  tokens: number;
  /** The session's context window. */
  limit: number;
  /** True while a main turn is in flight — the row goes inert. */
  busy: boolean;
  onCompact: () => void;
}

/**
 * Clickable banner warning that a session's context has filled past the user's
 * configured budget. Clicking runs `/compact` on the session.
 *
 * Deliberately NOT dismissible, unlike AccountMismatchBanner: a warning you can
 * wave away becomes a warning you wave away reflexively. It clears when context
 * actually drops below the budget, or when the setting is turned off.
 *
 * No borders — the unlayered `* { border-color }` rule in styles.css overrides
 * Tailwind border-color utilities app-wide, so a bordered banner would not
 * render the intended color.
 *
 * See docs/superpowers/specs/2026-07-30-context-pressure-banner-design.md
 */
export const ContextPressureBanner: React.FC<ContextPressureBannerProps> = ({
  pressure,
  tokens,
  limit,
  busy,
  onCompact,
}) => {
  if (pressure.level === 'none') return null;

  const critical = pressure.level === 'critical';
  const Icon = critical ? AlertOctagon : AlertTriangle;

  const threshold = `${formatTokens(pressure.budgetTokens)} compact threshold`;
  const standing = critical
    ? `over your ${threshold}`
    : `80% of your ${threshold}`;
  const action = busy
    ? '…waiting for the current turn.'
    : 'Click to run /compact.';

  return (
    <button
      type="button"
      onClick={onCompact}
      disabled={busy}
      title={busy ? 'Waiting for the current turn to finish' : 'Run /compact on this session'}
      className={cn(
        "flex w-full items-start gap-2 px-3 py-2 text-xs text-left",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        critical
          ? "bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20"
          : "bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20",
        busy && "cursor-default hover:bg-transparent",
      )}
    >
      <Icon className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
      <span className="flex-1">
        Context{" "}
        <span className="font-mono">{formatTokens(tokens)}</span>
        {" / "}
        <span className="font-mono">{formatTokens(limit)}</span>
        {" "}({Math.round(pressure.pct)}%) — {standing}. {action}
      </span>
    </button>
  );
};
