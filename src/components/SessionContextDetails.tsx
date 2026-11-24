import * as React from "react";
import { Copy, Check, ChevronRight, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionContextUsage, SessionContextUsageCategory } from "@/lib/api";
import { fireAndLog } from "@/lib/fireAndLog";
import { SignalActionCard } from "./signals/SignalActionCard";
import { SignalEventLog } from "./signals/SignalEventLog";
import { formatTokens, type ContextPressureLevel } from "@/lib/contextPressure";
import type { SessionSignal } from "@/lib/signals/types";
import { loadoutSummary, type LoadoutCounts } from "@/lib/sessionLoadout";

// Not the old `detailsOpen` key: it holds a stale "0" for anyone who ever opened the popover.
const DETAILS_STORAGE_KEY = "greychrist.sessionCard.detailsExpanded";
const EVENTS_STORAGE_KEY = "greychrist.sessionCard.eventsExpanded";

// Only a click writes it, never mounting, so an untouched one keeps its default.
function useStickyDisclosure(key: string, defaultOpen: boolean): [boolean, () => void] {
  const [open, setOpen] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return defaultOpen;
    const stored = window.localStorage.getItem(key);
    return stored === null ? defaultOpen : stored === "1";
  });
  const toggle = React.useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") window.localStorage.setItem(key, next ? "1" : "0");
      return next;
    });
  }, [key]);
  return [open, toggle];
}

function DisclosureToggle({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
    >
      <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
      {label}
    </button>
  );
}

// Keyed on `context.level` (the configured budget), never a percentage of the window.
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

const CATEGORY_COLORS = [
  "#60a5fa",
  "#a78bfa",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#22d3ee",
  "#f87171",
  "#a3e635",
];

const FREE_COLOR = "rgba(148, 163, 184, 0.35)";
// Match on the CLI's row `id` (2.1.304+); the name test is for older CLIs that send none.
const isFreeCategory = (c: SessionContextUsageCategory): boolean =>
  c.id !== undefined ? c.id === "free_space" : /free|remaining|available/i.test(c.name);

export interface ContextBand {
  name: string;
  value: number;
  color: string;
}

export interface ContextReading {
  tokens: number;
  limit: number;
  pct: number;
  level: ContextPressureLevel;
  /** 0 when no budget is known. */
  budgetTokens: number;
  budgetPct: number;
  fromCli: boolean;
  hasBreakdown: boolean;
  bands: ContextBand[];
}

export interface ContextInputs {
  totalTokens: number;
  /** From resolveContextLimit, so every gauge and the pressure signals agree. */
  contextLimit: number;
  contextUsage?: SessionContextUsage | null;
  contextLevelSignal?: SessionSignal;
}

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
          .filter((c) => !isClamped || !isFreeCategory(c))
      : [];

  const categoriesSum = sorted.reduce((acc, c) => acc + c.tokens, 0);
  let usedColorIdx = 0;
  const slices = sorted.map((c) => ({
    name: c.name,
    value: c.tokens,
    color: isFreeCategory(c)
      ? FREE_COLOR
      : CATEGORY_COLORS[usedColorIdx++ % CATEGORY_COLORS.length],
  }));
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

export function formatContextTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export interface SessionContextDetailsProps {
  reading: ContextReading;
  sessionId?: string | null;
  pendingAction?: SessionSignal | null;
  recentEvents?: SessionSignal[];
  /** Always offered, never signal-derived: the boundary action only fires at 100% of the budget. */
  onCompact?: () => void;
  compactDisabled?: boolean;
  loadout?: LoadoutCounts | null;
  onOpenLoadout?: () => void;
  onJumpToMessage?: (messageUuid: string) => void;
}

export function SessionContextDetails({
  reading: r,
  sessionId,
  pendingAction = null,
  recentEvents = [],
  onCompact,
  compactDisabled = false,
  loadout = null,
  onOpenLoadout,
  onJumpToMessage,
}: SessionContextDetailsProps): React.JSX.Element {
  const loadoutText = loadout ? loadoutSummary(loadout) : null;
  const [detailsOpen, toggleDetails] = useStickyDisclosure(DETAILS_STORAGE_KEY, true);
  const [eventsOpen, toggleEvents] = useStickyDisclosure(EVENTS_STORAGE_KEY, false);

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

      <div className="pt-2 mt-1 border-t border-border/50" data-testid="details-disclosure">
        <DisclosureToggle label="Details" open={detailsOpen} onToggle={toggleDetails} />
        {detailsOpen && (
          <div className="mt-2 flex flex-col gap-2">
        {r.fromCli && r.hasBreakdown ? (
          <>
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

      <div className="pt-2 mt-1 border-t border-border/50" data-testid="recent-events">
        <DisclosureToggle label="Recent events" open={eventsOpen} onToggle={toggleEvents} />
        {eventsOpen && (
          <SignalEventLog className="mt-1" events={recentEvents} onSelect={onJumpToMessage} />
        )}
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
