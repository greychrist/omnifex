import * as React from "react";
import { Database, RotateCcw, RefreshCw, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { resolveContextLimit } from "@/lib/contextLimit";
import type { SessionContextUsage } from "@/lib/api";
import { Popover } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { HeaderLabel } from "./HeaderLabel";
import { CacheTimerRow } from "./CacheTimerRow";
import { fireAndLog } from "@/lib/fireAndLog";
import { ActivityPill } from "./signals/ActivityPill";
import { SignalBadge } from "./signals/SignalBadge";
import { SignalActionCard } from "./signals/SignalActionCard";
import { SignalEventLog } from "./signals/SignalEventLog";
import { formatTokens, type ContextPressureLevel } from "@/lib/contextPressure";
import type { SessionSignal } from "@/lib/signals/types";

/**
 * Meter colour by proximity to the compaction boundary.
 *
 * Read from `context.level`, which resolves the user's configured budget —
 * never from a hardcoded percentage of the window. The two are not the same
 * scale: a 250k budget on a 1M window is critical at 25% full, and a meter
 * colouring by window percentage would still be showing green there while the
 * attention slot asked the user to compact.
 */
const METER_FILL: Record<ContextPressureLevel, string> = {
  none: "bg-emerald-500",
  warn: "bg-amber-500",
  critical: "bg-red-500",
};

const METER_TEXT: Record<ContextPressureLevel, string> = {
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

interface SessionCardProps {
  totalTokens: number;
  model?: string;
  /** The account's resolved default model (settings.json `model`, e.g.
   *  "opus[1m]"). Lets the client-side fallback detect a 1M window for an
   *  "Account Default" session whose own model string lacks the [1m] suffix —
   *  notably a resumed session (history loaded statically, no live usage yet)
   *  or a TUI session. See resolveContextLimit. */
  defaultModel?: string | null;
  contextUsage?: SessionContextUsage | null;
  /** Prompt-cache clock, from AgentSession. Both null when the timer is
   *  disabled or no turn has written cache yet — the row then hides. The
   *  countdown itself ticks inside CacheTimerRow, not here. */
  cacheAnchorMs?: number | null;
  cacheTtlMs?: number | null;
  /** True while a main turn is in flight; the cache row goes neutral. */
  cacheBusy?: boolean;
  sessionStatus?: 'starting' | 'active' | 'ended';
  /** Force-reconnect button click handler. Renders inside the status badge
   *  while sessionStatus === 'ended'. */
  onReconnect?: () => void;
  /** Restart / Clear-conversation button click handler. */
  onClear?: () => void;
  clearDisabled?: boolean;
  clearReason?: string;
  /** Current Claude session id (GUID). When present, surfaces in the context
   *  popover with a copy button. */
  sessionId?: string | null;
  /**
   * Live session controls (model / effort / permission pickers) rendered
   * inside the context popover. Injected by AgentSession so this card stays
   * presentation-only.
   */
  controls?: React.ReactNode;
  /** One-line rollup of the active controls ("Fable 5 | High | Auto Review"),
   *  rendered in thin small type above the context gauge so the live state is
   *  visible without opening the popover. */
  controlsSummary?: string | null;
  /** `session.activity` state signal — drives the second status pill. */
  activitySignal?: SessionSignal;
  /** `context.level` state signal — drives the meter's colour and the
   *  compact-at readout. Falls back to an uncoloured meter when absent. */
  contextLevelSignal?: SessionSignal;
  /** Unread `event`s anchored to `session`. */
  unreadEvents?: number;
  /** A pending `action` anchored here, mirrored as a card atop the popover. */
  pendingAction?: SessionSignal | null;
  /** The anchor's recent events, newest first, already limited by the caller. */
  recentEvents?: SessionSignal[];
  /** Called when the popover opens, so the caller can clear the unread badge. */
  onSignalsRead?: () => void;
  /**
   * Runs `/compact` on this session. Omit and no button renders.
   *
   * Deliberately NOT derived from a signal. The boundary action only fires at
   * 100% of the budget, so between 80% and 100% the meter went amber with
   * nothing to click — the old context-pressure banner had been the only
   * always-visible compact affordance, and removing it took that with it.
   * Compacting is a thing you may want to do at any level, so it lives on the
   * widget permanently rather than appearing when the app decides it matters.
   */
  onCompact?: () => void;
  /** True while a turn is in flight; the button renders inert, not absent. */
  compactDisabled?: boolean;
  className?: string;
}

/**
 * Compact card summarizing the live session: status badge, context-window
 * widget (with detail popover), and a restart button. Pulled out of
 * SessionHeader so it can sit inline with the other top-toolbar cards
 * (folder, branch, account).
 */
export function SessionCard({
  totalTokens,
  model,
  defaultModel,
  contextUsage,
  cacheAnchorMs = null,
  cacheTtlMs = null,
  cacheBusy = false,
  sessionStatus,
  onReconnect,
  onClear,
  clearDisabled,
  clearReason,
  sessionId,
  controls,
  controlsSummary,
  activitySignal,
  contextLevelSignal,
  unreadEvents = 0,
  pendingAction = null,
  recentEvents = [],
  onSignalsRead,
  onCompact,
  compactDisabled = false,
  className,
}: SessionCardProps) {
  const [contextPopoverOpen, setContextPopoverOpen] = React.useState(false);

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
    <div className={cn("flex items-start gap-3 rounded-md border-0 bg-background/40 px-2 py-1 shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent),2px_2px_4px_rgb(0_0_0/0.08)]", className)}>
      <div className="flex flex-col items-start gap-0.5">
        <HeaderLabel>session</HeaderLabel>
        {sessionStatus && (() => {
          const statusColor =
            sessionStatus === 'active' ? '#22c55e' :
            sessionStatus === 'starting' ? '#f59e0b' :
            '#ef4444';
          return (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                sessionStatus === 'starting' && 'animate-pulse',
              )}
              style={{
                backgroundColor: `${statusColor}33`,
                color: statusColor,
                borderColor: `${statusColor}4d`,
              }}
            >
              {sessionStatus === 'active' && 'Active'}
              {sessionStatus === 'starting' && 'Starting…'}
              {sessionStatus === 'ended' && 'Closed'}
              {sessionStatus === 'ended' && onReconnect && (
                <button
                  type="button"
                  onClick={onReconnect}
                  className="inline-flex items-center justify-center rounded-sm hover:bg-white/10 transition-colors p-0.5 -mr-0.5"
                  style={{ color: statusColor }}
                  title="Force reconnect"
                  aria-label="Force reconnect"
                >
                  <RefreshCw className="h-3 w-3" />
                </button>
              )}
            </span>
          );
        })()}
        {/* Second pill, deliberately below rather than merged into the one
            above: that reports whether the CLI process is up (main-process
            owned), this reports what the session is doing. */}
        <ActivityPill signal={activitySignal} />
      </div>

      {(() => {
        const useSdk = contextUsage !== undefined && contextUsage !== null;
        const tokens = useSdk ? contextUsage.totalTokens : totalTokens;
        const sdkLimit = useSdk ? contextUsage.maxTokens : null;
        // Trust the live CLI window when present; only fall back to the model
        // "[1m]" heuristic before any live data arrives. (Fixes resume pinning
        // the gauge to 200k — see resolveContextLimit for the full rationale.)
        const limit = resolveContextLimit({ sdkMaxTokens: sdkLimit, model, defaultModel });
        if (tokens <= 0 || limit <= 0) return null;
        const pct = Math.min(100, (tokens / limit) * 100);
        const levelMeta = contextLevelSignal?.meta as
          | { level?: ContextPressureLevel; budgetTokens?: number; budgetPct?: number }
          | undefined;
        const level: ContextPressureLevel = levelMeta?.level ?? "none";
        const color = METER_TEXT[level];
        const budgetTokens = levelMeta?.budgetTokens ?? 0;
        const budgetPct = levelMeta?.budgetPct ?? 0;

        const FREE_COLOR = "rgba(148, 163, 184, 0.35)";
        const isFreeCategory = (name: string) =>
          /free|remaining|available/i.test(name);
        const isClamped = sdkLimit != null && limit < sdkLimit;
        const sortedCategories =
          useSdk && contextUsage.categories.length > 0
            ? contextUsage.categories
                .slice()
                .sort((a, b) => b.tokens - a.tokens)
                .filter((c) => c.tokens > 0)
                .filter((c) => !isClamped || !isFreeCategory(c.name))
            : [];

        const categoriesSum = sortedCategories.reduce((acc, c) => acc + c.tokens, 0);
        let usedColorIdx = 0;
        const slicesFromCategories = sortedCategories.map((c) => {
          const free = isFreeCategory(c.name);
          const sliceColor = free
            ? FREE_COLOR
            : CATEGORY_COLORS[usedColorIdx++ % CATEGORY_COLORS.length];
          return { name: c.name, value: c.tokens, color: sliceColor };
        });
        // Trailing free space is a band like any other, so the bar always
        // spans the window and a category's width is directly comparable to it.
        const bands =
          categoriesSum < limit
            ? [
                ...slicesFromCategories,
                {
                  name: "Free",
                  value: limit - categoriesSum,
                  color: FREE_COLOR,
                },
              ]
            : slicesFromCategories;

        return (
          <div className="flex flex-1 min-w-0 flex-col items-stretch gap-0.5">
            <HeaderLabel className="font-light lowercase whitespace-nowrap truncate">
              {controlsSummary || '\u00A0'}
            </HeaderLabel>
          <Popover
            open={contextPopoverOpen}
            onOpenChange={(next) => {
              setContextPopoverOpen(next);
              // Opening the popover IS reading the events — a separate
              // "mark read" control would be one more thing to forget.
              if (next) onSignalsRead?.();
            }}
            align="end"
            side="bottom"
            className="w-96"
            triggerClassName="relative block w-full"
            trigger={
              <button
                type="button"
                // Its visible text is "120.0k 12%", which a screen reader
                // announces as two bare numbers with no subject.
                aria-label="Context usage"
                aria-expanded={contextPopoverOpen}
                className={cn(
                  "inline-flex w-full items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono font-medium cursor-pointer text-foreground",
                  "bg-background shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent)]",
                )}
              >
                <SignalBadge count={unreadEvents} label="session" />
                <Database className="w-3.5 h-3.5 text-foreground" />
                <span className={cn("font-mono", color)}>
                  {tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens}
                </span>
                <div className="flex-1 min-w-11 h-1.5 bg-foreground/10 rounded-full overflow-hidden relative">
                  <div
                    className={cn("absolute inset-y-0 left-0 rounded-full transition-all", METER_FILL[level])}
                    style={{ width: `${pct}%` }}
                  />
                  {/* Where /compact becomes the ask. Without it the meter shows
                      a bar filling toward 100% of the WINDOW, while the colour
                      and the attention slot answer to the budget instead —
                      which reads as the meter contradicting itself. */}
                  {budgetPct > 0 && budgetPct < 100 && (
                    <div
                      className="absolute inset-y-0 w-px bg-foreground/50"
                      style={{ left: `${budgetPct}%` }}
                    />
                  )}
                </div>
                <span className="text-foreground font-mono">{pct.toFixed(0)}%</span>
              </button>
            }
            content={
              <div className="flex flex-col gap-2 text-left">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-semibold">Context</span>
                  <span className={cn("font-mono text-sm", color)}>
                    {pct.toFixed(1)}%
                  </span>
                </div>
                <div className="text-xs text-muted-foreground font-mono">
                  {tokens.toLocaleString()} / {limit.toLocaleString()} tokens
                </div>
                {budgetTokens > 0 && (
                  <div className="text-[10px] text-muted-foreground font-mono">
                    boundary {formatTokens(budgetTokens)} · compact at{" "}
                    {budgetPct.toFixed(0)}%
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

                {controls && (
                  <div className="pt-2 mt-1 border-t border-border/50">
                    {controls}
                  </div>
                )}

                {useSdk && sortedCategories.length > 0 ? (
                  <>
                    {/* A stacked bar, not a donut. The pie cost 18rem of
                        popover height to encode one number per category —
                        exactly what the legend underneath it already lists,
                        and more precisely. Proportions survive; the height
                        does not. */}
                    <div className="flex h-2.5 w-full overflow-hidden rounded-sm bg-foreground/5">
                      {bands.map((band) => (
                        <div
                          key={band.name}
                          data-context-band={band.name}
                          title={`${band.name} — ${band.value.toLocaleString()} tokens`}
                          style={{
                            width: `${limit > 0 ? (band.value / limit) * 100 : 0}%`,
                            backgroundColor: band.color,
                          }}
                        />
                      ))}
                    </div>
                    <div className="flex flex-col gap-1">
                      {bands.map((band) => {
                        const catPct = limit > 0 ? (band.value / limit) * 100 : 0;
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

                <div className="pt-2 mt-1 border-t border-border/50">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Recent events
                  </div>
                  <SignalEventLog events={recentEvents} />
                </div>

                {sessionId && (
                  <div className="pt-1 mt-1 border-t border-border/50 flex items-center gap-2 text-[10px] text-muted-foreground">
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
                  {useSdk
                    ? "query.getContextUsage()"
                    : "client-side estimate (fallback)"}
                </div>
              </div>
            }
          />
          {/* Prompt-cache countdown, directly under the gauge bar. Lives inside
              this column so it sits below the bar rather than beside it, which
              also means it needs context data to have arrived — by which point
              a cache write has been observed anyway. */}
          <CacheTimerRow
            anchorMs={cacheAnchorMs}
            ttlMs={cacheTtlMs}
            busy={cacheBusy}
          />
          </div>
        );
      })()}
      {onClear && (
        <div className="flex flex-col items-start gap-0.5">
          <HeaderLabel>&nbsp;</HeaderLabel>
        <Button
          size="sm"
          variant="outline"
          onClick={onClear}
          disabled={clearDisabled}
          className="h-5 w-5 p-0 rounded-sm border-0 shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent)]"
          title={clearReason ?? 'Close this session and open a new one'}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
        </div>
      )}
    </div>
  );
}
