import * as React from "react";
import { Database, RotateCcw, RefreshCw, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionContextUsage } from "@/lib/api";
import { Popover } from "@/components/ui/popover";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { Button } from "@/components/ui/button";
import { HeaderLabel } from "./HeaderLabel";

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

interface SessionCardProps {
  totalTokens: number;
  model?: string;
  contextUsage?: SessionContextUsage | null;
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
  contextUsage,
  sessionStatus,
  onReconnect,
  onClear,
  clearDisabled,
  clearReason,
  sessionId,
  className,
}: SessionCardProps) {
  const [contextPopoverOpen, setContextPopoverOpen] = React.useState(false);

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

  const [chartReady, setChartReady] = React.useState(false);
  React.useEffect(() => {
    if (contextPopoverOpen) {
      const id = requestAnimationFrame(() => setChartReady(true));
      return () => { cancelAnimationFrame(id); setChartReady(false); };
    }
    setChartReady(false);
  }, [contextPopoverOpen]);

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
      </div>

      {(() => {
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

        const FREE_COLOR = "rgba(148, 163, 184, 0.35)";
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

        const categoriesSum = sortedCategories.reduce((acc, c) => acc + c.tokens, 0);
        let usedColorIdx = 0;
        const slicesFromCategories = sortedCategories.map((c) => {
          const free = isFreeCategory(c.name);
          const sliceColor = free
            ? FREE_COLOR
            : CATEGORY_COLORS[usedColorIdx++ % CATEGORY_COLORS.length];
          return { name: c.name, value: c.tokens, color: sliceColor };
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
          <div className="flex flex-col items-start gap-0.5">
            <HeaderLabel>&nbsp;</HeaderLabel>
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
                <div className="w-11 h-1.5 bg-foreground/10 rounded-full overflow-hidden relative">
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
