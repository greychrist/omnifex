import * as React from "react";
import {
  Database,
  RotateCcw,
  RefreshCw,
  Copy,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  SessionContextUsage,
} from "@/lib/api";
import { Popover } from "@/components/ui/popover";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { Button } from "@/components/ui/button";

/**
 * Small uppercase label rendered above each header badge ("account", "branch",
 * "mode", etc.). Shared component so a single style change propagates to every
 * caller — both inside SessionHeader and in adjacent toolbar widgets.
 */
export function HeaderLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("text-[11px] tracking-wider text-muted-foreground", className)}>
      {children}
    </span>
  );
}

// Palette for context-usage categories. Each category comes with its own
// `color` from the SDK, but those default colors sometimes clash with our
// dark palette, so we override with our own sequence and fall back to the
// SDK color if we run out of slots.
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

interface SessionHeaderProps {
  accountName: string;
  accountType: string;
  cost: number;
  totalTokens: number;
  model?: string;
  /**
   * Session status indicator:
   *  - 'starting' — subprocess is up but the SDK control channel hasn't
   *    answered yet (Claude Code 0.2.114 only responds after the first user
   *    message, so MCP list / account info / tool list are still empty).
   *  - 'active' — control channel responded, metadata is fully populated.
   *  - 'ended' — subprocess closed or session was stopped.
   */
  sessionStatus?: 'starting' | 'active' | 'ended';
  /**
   * Authoritative context-window usage from query.getContextUsage(), fetched
   * at session init and at the end of every turn. When present, the widget
   * uses totalTokens/maxTokens/categories from this object instead of the
   * client-side (totalTokens / hardcoded limit) approximation — which gives
   * real numbers for system prompt, tools, memory, MCP, etc. rather than
   * just the assistant-reported message-token count.
   */
  contextUsage?: SessionContextUsage | null;
  /** Restart / Clear-conversation button click handler. */
  onClear?: () => void;
  /** Whether the restart button is disabled (no session, mid-turn, etc.). */
  clearDisabled?: boolean;
  /** Tooltip explaining why restart is disabled, when it is. */
  clearReason?: string;
  /** Force-reconnect button click handler. Renders an inline reconnect icon
   *  inside the status badge while sessionStatus === 'ended'. */
  onReconnect?: () => void;
  /** Current Claude session id (GUID). When present, surfaces in the
   *  context popover with a copy button so it's easy to grab for support
   *  threads, JSONL lookups, etc. Null/undefined hides the row. */
  sessionId?: string | null;

  className?: string;
}

/** Working-tree status for a single sibling worktree. */
export interface WorktreeSnapshot {
  /** Absolute worktree path — used as a stable React key + tooltip detail. */
  path: string;
  branch: string | null;
  changed: number;
  untracked: number;
  /** Latest error from the per-worktree git read, or null when healthy. */
  error: string | null;
  /**
   * Main-process watchId for the per-peer status watch. Undefined while the
   * row is in its seeded "loading" state before the per-peer watch resolves.
   */
  watchId?: string;
}

export function SessionHeader({
  accountType,
  cost,
  totalTokens,
  model,
  contextUsage,
  onClear,
  clearDisabled,
  clearReason,
  onReconnect,
  sessionStatus,
  sessionId,
  className,
}: SessionHeaderProps) {
  const [contextPopoverOpen, setContextPopoverOpen] = React.useState(false);

  // Briefly swap the copy icon for a check after a successful clipboard
  // write. Resets after 1.2s so the next copy click feels responsive.
  const [sessionIdCopied, setSessionIdCopied] = React.useState(false);
  const handleCopySessionId = React.useCallback(async () => {
    if (!sessionId) return;
    try {
      await navigator.clipboard.writeText(sessionId);
      setSessionIdCopied(true);
      setTimeout(() => setSessionIdCopied(false), 1200);
    } catch (err) {
      console.error("Failed to copy session id:", err);
    }
  }, [sessionId]);

  // Defer chart rendering by one frame so the popover container has dimensions
  const [chartReady, setChartReady] = React.useState(false);
  React.useEffect(() => {
    if (contextPopoverOpen) {
      const id = requestAnimationFrame(() => setChartReady(true));
      return () => { cancelAnimationFrame(id); setChartReady(false); };
    }
    setChartReady(false);
  }, [contextPopoverOpen]);

  const showCost = accountType !== "max";

  return (
    <div className={cn(
      "flex items-start gap-3 px-4 py-2 border-b border-border/50 bg-muted text-xs shrink-0",
      className
    )}>
      <div className="flex flex-col items-start gap-0.5">
      <HeaderLabel>session</HeaderLabel>
      <div className="flex items-center gap-3 rounded-md border border-border/50 bg-background/40 px-2 py-1">
      {/* Session status indicator — inline styles so the border picks up the
          status color (Tailwind v4's border-{color}/{alpha} utilities
          desaturate under this theme). */}
      {sessionStatus && (() => {
        const statusColor =
          sessionStatus === 'active' ? '#22c55e' :
          sessionStatus === 'starting' ? '#f59e0b' :
          '#ef4444'; // ended
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

      {(() => {
        // Prefer authoritative numbers from query.getContextUsage() when
        // present; otherwise fall back to the old client-side approximation
        // (messages totalTokens / hardcoded context limit for the model).
        //
        // Caveat: the SDK's getContextUsage() reports the model's *maximum*
        // supportable window (1M for Opus 4.x), not whatever the picker
        // selected. If the user picked a 200K alias we clamp the limit so
        // the donut reads against the actual budget the session is using —
        // otherwise a 200K session shows 4% used at 42K which is misleading.
        const useSdk = contextUsage !== undefined && contextUsage !== null;
        const tokens = useSdk ? contextUsage!.totalTokens : totalTokens;
        const expectsLargeContext = !!model?.includes("[1m]");
        const sdkLimit = useSdk ? contextUsage!.maxTokens : null;
        const limit = sdkLimit != null
          ? expectsLargeContext
            ? sdkLimit
            : Math.min(sdkLimit, 200_000)
          : expectsLargeContext
            ? 1_000_000
            : 200_000;
        if (tokens <= 0 || limit <= 0) return null;
        const pct = Math.min(100, (tokens / limit) * 100);
        const color = pct > 80 ? "text-red-400" : pct > 50 ? "text-orange-400" : "text-foreground";

        // Build pie-chart data from SDK categories (descending by tokens).
        //
        // The SDK reports a "Free space" category sized against its own
        // maxTokens (1M for Opus 4.x). When we clamp the limit to 200K we
        // must drop the SDK's Free slice and synthesize one against the
        // clamped limit — otherwise a 924K Free slice would dominate a
        // donut that's supposed to total 200K.
        const FREE_COLOR = "rgba(148, 163, 184, 0.35)"; // slate-400 @35%
        const isFreeCategory = (name: string) =>
          /free|remaining|available/i.test(name);
        const isClamped = sdkLimit != null && limit < sdkLimit;
        const sortedCategories =
          useSdk && contextUsage!.categories.length > 0
            ? contextUsage!.categories
                .slice()
                .sort((a, b) => b.tokens - a.tokens)
                .filter((c) => c.tokens > 0)
                .filter((c) => !isClamped || !isFreeCategory(c.name))
            : [];

        const categoriesSum = sortedCategories.reduce(
          (acc, c) => acc + c.tokens,
          0,
        );
        // Color assignment: "Free-like" categories get the slate backdrop
        // color, other (used) categories get palette entries in the order
        // they appear. Using a separate counter for non-free categories so
        // we don't waste the first palette color on Free space when it
        // happens to be the largest slice.
        let usedColorIdx = 0;
        const slicesFromCategories = sortedCategories.map((c) => {
          const free = isFreeCategory(c.name);
          const color = free
            ? FREE_COLOR
            : CATEGORY_COLORS[usedColorIdx++ % CATEGORY_COLORS.length];
          return { name: c.name, value: c.tokens, color };
        });
        const pieData =
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
            <Popover
            open={contextPopoverOpen}
            onOpenChange={setContextPopoverOpen}
            align="end"
            side="bottom"
            className="w-96"
            trigger={
              <button
                type="button"
                className={cn(
                  "inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono font-medium cursor-pointer text-foreground",
                  "bg-background shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent)]",
                )}
              >
                <Database className="w-3.5 h-3.5 text-foreground" />
                <span className={cn("font-mono", color)}>
                  {tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens}
                </span>
                <div className="w-16 h-1.5 bg-foreground/10 rounded-full overflow-hidden relative">
                  {/*
                    The fill is a single full-width gradient (green → orange → red)
                    clipped from the right by `inset-right: (100 - pct)%`. This way
                    the visible bar always shows the gradient from 0% to whatever
                    the current usage is — at 30% the bar is still all-green; at
                    90% it crosses into the red end. transitions stay smooth.
                  */}
                  <div
                    className="absolute inset-0 rounded-full bg-gradient-to-r from-green-400 via-orange-400 to-red-400 transition-[clip-path]"
                    style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}
                  />
                </div>
                <span className="text-foreground font-mono">{pct.toFixed(0)}%</span>
              </button>
            }
            content={
              <div className="flex flex-col gap-2 text-left">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-semibold">Context window</span>
                  <span className={cn("font-mono text-sm", color)}>
                    {pct.toFixed(1)}%
                  </span>
                </div>
                <div className="text-xs text-muted-foreground font-mono">
                  {tokens.toLocaleString()} / {limit.toLocaleString()} tokens
                </div>

                {useSdk && sortedCategories.length > 0 && chartReady ? (
                  <>
                    <div className="h-72 -mx-2">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={pieData}
                            dataKey="value"
                            nameKey="name"
                            cx="50%"
                            cy="50%"
                            innerRadius={76}
                            outerRadius={120}
                            paddingAngle={1}
                            stroke="none"
                            isAnimationActive={false}
                          >
                            {pieData.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={entry.color} />
                            ))}
                          </Pie>
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="flex flex-col gap-1">
                      {pieData.map((slice) => {
                        const catPct =
                          limit > 0 ? (slice.value / limit) * 100 : 0;
                        return (
                          <div
                            key={slice.name}
                            className="flex items-center gap-2 text-xs"
                          >
                            <span
                              className="inline-block w-2 h-2 rounded-sm shrink-0"
                              style={{ backgroundColor: slice.color }}
                            />
                            <span className="flex-1 truncate text-foreground/80">
                              {slice.name}
                            </span>
                            <span className="font-mono text-foreground/60 shrink-0">
                              {slice.value.toLocaleString()}
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
                    Category breakdown not yet available — waiting for the SDK
                    to report per-category usage.
                  </div>
                )}

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
                      onClick={handleCopySessionId}
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
        );
      })()}
      {onClear && (
        <Button
          size="sm"
          variant="outline"
          onClick={onClear}
          disabled={clearDisabled}
          className="h-7 w-7 p-0"
          title={clearReason ?? 'Close this session and open a new one'}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      )}
      </div>
      </div>

      {showCost && (
        <span className="ml-auto self-end text-foreground/50 font-mono">
          ${cost.toFixed(4)}
        </span>
      )}
    </div>
  );
}
