import * as React from "react";
import { Copy, Check, ChevronRight, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionContextUsage } from "@/lib/api";
import { fireAndLog } from "@/lib/fireAndLog";
import { SignalActionCard } from "./signals/SignalActionCard";
import { SignalEventLog } from "./signals/SignalEventLog";
import { formatTokens, type ContextPressureLevel } from "@/lib/contextPressure";
import type { SessionSignal } from "@/lib/signals/types";
import { loadoutSummary, type LoadoutCounts } from "@/lib/sessionLoadout";

/**
 * The session's context reading and the popover that explains it.
 *
 * Shared by the session widget and the status bar's `session` readout, which
 * open the same popover from two triggers. One module, so the two cannot drift
 * into disagreeing about how full the window is.
 */

/** Legacy `greychrist.` prefix, like every other localStorage key here. */
const DETAILS_STORAGE_KEY = "greychrist.sessionCard.detailsOpen";

/**
 * Colour by proximity to the compaction boundary.
 *
 * Read from `context.level`, which resolves the user's configured budget —
 * never from a hardcoded percentage of the window. The two are not the same
 * scale: a 250k budget on a 1M window is critical at 25% full, and a meter
 * colouring by window percentage would still be showing green there while the
 * attention slot asked the user to compact.
 */
export const METER_FILL: Record<ContextPressureLevel, string> = {
  none: "bg-emerald-500",
  warn: "bg-amber-500",
  critical: "bg-red-500",
};

export const METER_TEXT: Record<ContextPressureLevel, string> = {
  none: "text-foreground",
  warn: "text-amber-500",
  critical: "text-red-500",
};

// Palette for context-usage categories. Each category comes with its own
// `color` from the CLI, but those default colors sometimes clash with our
// dark palette, so we override with our own sequence and fall back to the
// CLI color if we run out of slots.
const CATEGORY_COLORS = [
  "#60a5fa", // blue-400
  "#a78bfa", // violet-400
  "#34d399", // emerald-400
  "#fbbf24", // amber-400
  "#f472b6", // pink-400
  "#22d3ee", // cyan-400
  "#f87171", // red-400
  "#a3e635", // lime-400
];

const FREE_COLOR = "rgba(148, 163, 184, 0.35)";
const isFreeCategory = (name: string): boolean => /free|remaining|available/i.test(name);

export interface ContextBand {
  name: string;
  value: number;
  color: string;
}

export interface ContextReading {
  tokens: number;
  /** The window the gauge is sized against. */
  limit: number;
  /** Share of `limit`, capped at 100. */
  pct: number;
  level: ContextPressureLevel;
  /** Where /compact becomes the ask; 0 when no budget is known. */
  budgetTokens: number;
  budgetPct: number;
  /** True when the numbers came from the CLI's own `getContextUsage`. */
  fromCli: boolean;
  /** True when the CLI reported a per-category breakdown. */
  hasBreakdown: boolean;
  /** Categories, largest first, then trailing free space — spans the window. */
  bands: ContextBand[];
}

export interface ContextInputs {
  totalTokens: number;
  /** From resolveContextLimit in the parent — one computation, so every
   *  gauge and the pressure signals agree. */
  contextLimit: number;
  contextUsage?: SessionContextUsage | null;
  contextLevelSignal?: SessionSignal;
}

/** Null until there is something to show: no tokens yet, or no window. */
export function readContext({
  totalTokens,
  contextLimit,
  contextUsage,
  contextLevelSignal,
}: ContextInputs): ContextReading | null {
  const fromCli = contextUsage !== undefined && contextUsage !== null;
  const tokens = fromCli ? contextUsage.totalTokens : totalTokens;
  const cliLimit = fromCli ? contextUsage.maxTokens : null;
  const limit = contextLimit;
  if (tokens <= 0 || limit <= 0) return null;
  const pct = Math.min(100, (tokens / limit) * 100);
  const levelMeta = contextLevelSignal?.meta as
    | { level?: ContextPressureLevel; budgetTokens?: number; budgetPct?: number }
    | undefined;

  const isClamped = cliLimit != null && limit < cliLimit;
  const sorted =
    fromCli && contextUsage.categories.length > 0
      ? contextUsage.categories
          .slice()
          .sort((a, b) => b.tokens - a.tokens)
          .filter((c) => c.tokens > 0)
          .filter((c) => !isClamped || !isFreeCategory(c.name))
      : [];

  const categoriesSum = sorted.reduce((acc, c) => acc + c.tokens, 0);
  let usedColorIdx = 0;
  const slices = sorted.map((c) => ({
    name: c.name,
    value: c.tokens,
    color: isFreeCategory(c.name)
      ? FREE_COLOR
      : CATEGORY_COLORS[usedColorIdx++ % CATEGORY_COLORS.length],
  }));
  // Trailing free space is a band like any other, so the bar always
  // spans the window and a category's width is directly comparable to it.
  const bands =
    categoriesSum < limit
      ? [...slices, { name: "Free", value: limit - categoriesSum, color: FREE_COLOR }]
      : slices;

  return {
    tokens,
    limit,
    pct,
    level: levelMeta?.level ?? "none",
    budgetTokens: levelMeta?.budgetTokens ?? 0,
    budgetPct: levelMeta?.budgetPct ?? 0,
    fromCli,
    hasBreakdown: sorted.length > 0,
    bands,
  };
}

/** `157.1k` — the gauge's own token format. */
export function formatContextTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export interface SessionContextDetailsProps {
  reading: ContextReading;
  /** Current Claude session id (GUID), shown with a copy button. */
  sessionId?: string | null;
  /** A pending `action` anchored here, mirrored as a card atop the popover. */
  pendingAction?: SessionSignal | null;
  /** The anchor's recent events, newest first, already limited by the caller. */
  recentEvents?: SessionSignal[];
  /**
   * Runs `/compact` on this session. Omit and no button renders.
   *
   * Deliberately NOT derived from a signal. The boundary action only fires at
   * 100% of the budget, so between 80% and 100% the meter went amber with
   * nothing to click. Compacting is a thing you may want to do at any level,
   * so it is offered permanently rather than when the app decides it matters.
   */
  onCompact?: () => void;
  /** True while a turn is in flight; the button renders inert, not absent. */
  compactDisabled?: boolean;
  /** What is loaded into the session. The lists live in the Session context
   *  panel; the popover gives the counts and a way there. */
  loadout?: LoadoutCounts | null;
  onOpenLoadout?: () => void;
}

/** The popover body. Each trigger owns its own open state. */
export function SessionContextDetails({
  reading: r,
  sessionId,
  pendingAction = null,
  recentEvents = [],
  onCompact,
  compactDisabled = false,
  loadout = null,
  onOpenLoadout,
}: SessionContextDetailsProps): React.JSX.Element {
  const loadoutText = loadout ? loadoutSummary(loadout) : null;
  // Collapsed by default, sticky once opened — and shared by both triggers,
  // since it is one preference about one popover.
  const [detailsOpen, setDetailsOpen] = React.useState<boolean>(
    () => typeof window !== "undefined" && window.localStorage.getItem(DETAILS_STORAGE_KEY) === "1",
  );
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(DETAILS_STORAGE_KEY, detailsOpen ? "1" : "0");
  }, [detailsOpen]);

  const [sessionIdCopied, setSessionIdCopied] = React.useState(false);
  const handleCopySessionId = React.useCallback(async () => {
    if (!sessionId) return;
    try {
      await navigator.clipboard.writeText(sessionId);
      setSessionIdCopied(true);
      setTimeout(() => { setSessionIdCopied(false); }, 1200);
    } catch (err) {
      console.error("Failed to copy session id:", err);
    }
  }, [sessionId]);

  return (
    <div className="flex flex-col gap-2 text-left">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold">Context</span>
        <span className={cn("font-mono text-sm", METER_TEXT[r.level])}>
          {r.pct.toFixed(1)}%
        </span>
      </div>
      <div className="text-xs text-muted-foreground font-mono">
        {r.tokens.toLocaleString()} / {r.limit.toLocaleString()} tokens
      </div>
      {r.budgetTokens > 0 && (
        <div className="text-[10px] text-muted-foreground font-mono">
          boundary {formatTokens(r.budgetTokens)} · compact at{" "}
          {r.budgetPct.toFixed(0)}%
        </div>
      )}

      {pendingAction && <SignalActionCard signal={pendingAction} />}

      {/* Suppressed when the action card is up: that card leads with
          its own Compact now, and two identical buttons stacked is
          worse than either alone. */}
      {onCompact && !pendingAction && (
        <button
          type="button"
          onClick={onCompact}
          disabled={compactDisabled}
          title={
            compactDisabled
              ? "Wait for the current turn to finish"
              : "Run /compact on this session"
          }
          className={cn(
            "self-start rounded-sm px-2 py-0.5 text-[11px] transition-colors",
            "bg-foreground/5 hover:bg-foreground/10",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "disabled:opacity-40 disabled:cursor-default disabled:hover:bg-foreground/5",
          )}
        >
          Compact now
        </button>
      )}

      {loadoutText && onOpenLoadout && (
        <button
          type="button"
          data-testid="loadout-summary"
          onClick={onOpenLoadout}
          title="Open Session context"
          className="flex items-center gap-1.5 self-start text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <Layers className="h-3 w-3 shrink-0" aria-hidden />
          <span>{loadoutText}</span>
        </button>
      )}

      {/* Collapsed by default, and sticky once opened. The
          breakdown is the tallest thing in the popover and answers a
          question asked occasionally ("what is eating the window?"),
          while everything around it is read every time. */}
      <div className="pt-2 mt-1 border-t border-border/50" data-testid="details-disclosure">
        <button
          type="button"
          onClick={() => { setDetailsOpen((v) => !v); }}
          aria-expanded={detailsOpen}
          className="flex w-full items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", detailsOpen && "rotate-90")} />
          Details
        </button>
        {detailsOpen && (
          <div className="mt-2 flex flex-col gap-2">
        {r.fromCli && r.hasBreakdown ? (
          <>
            {/* A stacked bar, not a donut. The pie cost 18rem of
                popover height to encode one number per category —
                exactly what the legend underneath it already lists,
                and more precisely. Proportions survive; the height
                does not. */}
            <div className="flex h-2.5 w-full overflow-hidden rounded-sm bg-foreground/5">
              {r.bands.map((band) => (
                <div
                  key={band.name}
                  data-context-band={band.name}
                  title={`${band.name} — ${band.value.toLocaleString()} tokens`}
                  style={{
                    width: `${r.limit > 0 ? (band.value / r.limit) * 100 : 0}%`,
                    backgroundColor: band.color,
                  }}
                />
              ))}
            </div>
            <div className="flex flex-col gap-1">
              {r.bands.map((band) => {
                const catPct = r.limit > 0 ? (band.value / r.limit) * 100 : 0;
                return (
                  <div
                    key={band.name}
                    className="flex items-center gap-2 text-xs"
                  >
                    <span
                      className="inline-block w-2 h-2 rounded-sm shrink-0"
                      style={{ backgroundColor: band.color }}
                    />
                    <span className="flex-1 truncate text-foreground/80">
                      {band.name}
                    </span>
                    <span className="font-mono text-foreground/60 shrink-0">
                      {band.value.toLocaleString()}
                    </span>
                    <span className="font-mono text-foreground/40 shrink-0 w-10 text-right">
                      {catPct.toFixed(1)}%
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="text-xs text-muted-foreground italic">
            Category breakdown not yet available — waiting for the CLI
            to report per-category usage.
          </div>
        )}
          </div>
        )}
      </div>

      {/* The badge on the trigger counts these, so the list has to
          be reachable without hunting. It used to sit ABOVE the
          category breakdown for that reason — underneath a full
          bands-plus-table block it fell off the bottom of a w-96
          popover, and the number cleared without its meaning ever
          being on screen. The breakdown now collapses by default,
          which solves that more directly and frees this to sit in
          reading order. */}
      <div className="pt-2 mt-1 border-t border-border/50" data-testid="recent-events">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Recent events
        </div>
        <SignalEventLog events={recentEvents} />
      </div>



      {sessionId && (
        <div className="pt-1 mt-1 border-t border-border/50 flex items-center gap-2 text-[10px] text-muted-foreground" data-testid="session-id">
          <span className="shrink-0">session</span>
          <span
            className="font-mono text-foreground/80 truncate"
            title={sessionId}
          >
            {sessionId}
          </span>
          <button
            type="button"
            onClick={fireAndLog('session-card:click', handleCopySessionId)}
            className="shrink-0 p-1 rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors"
            title={sessionIdCopied ? "Copied!" : "Copy session id"}
            aria-label="Copy session id"
          >
            {sessionIdCopied ? (
              <Check className="w-3 h-3 text-green-500" />
            ) : (
              <Copy className="w-3 h-3" />
            )}
          </button>
        </div>
      )}

      <div className="pt-1 mt-1 border-t border-border/50 text-[10px] text-muted-foreground">
        source:{" "}
        {r.fromCli
          ? "query.getContextUsage()"
          : "client-side estimate (fallback)"}
      </div>
    </div>
  );
}
