import * as React from "react";
import { Database, RotateCcw, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionContextUsage } from "@/lib/api";
import { Popover } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { HeaderLabel } from "./HeaderLabel";
import { useLayoutMode } from "@/hooks/useLayoutMode";
import { InlineDivider } from "@/components/ui/inline-divider";
import { ActivityPill } from "./signals/ActivityPill";
import {
  SessionContextDetails,
  readContext,
  formatContextTokens,
  METER_FILL,
  METER_TEXT,
} from "./SessionContextDetails";
import type { SessionSignal } from "@/lib/signals/types";

interface SessionCardProps {
  totalTokens: number;
  contextLimit: number;
  contextUsage?: SessionContextUsage | null;
  sessionStatus?: 'starting' | 'active' | 'ended';
  onReconnect?: () => void;
  onClear?: () => void;
  clearDisabled?: boolean;
  clearReason?: string;
  sessionId?: string | null;
  controlsSummary?: string | null;
  activitySignal?: SessionSignal;
  contextLevelSignal?: SessionSignal;
  pendingAction?: SessionSignal | null;
  recentEvents?: SessionSignal[];
  onSignalsRead?: () => void;
  /** Not derived from a signal: compacting must be offered at any level, not only at 100% of the budget. */
  onCompact?: () => void;
  compactDisabled?: boolean;
  className?: string;
}

export function SessionCard({
  totalTokens,
  contextLimit,
  contextUsage,
  sessionStatus,
  onReconnect,
  onClear,
  clearDisabled,
  clearReason,
  sessionId,
  controlsSummary,
  activitySignal,
  contextLevelSignal,
  pendingAction = null,
  recentEvents = [],
  onSignalsRead,
  onCompact,
  compactDisabled = false,
  className,
}: SessionCardProps) {
  const { narrow } = useLayoutMode();
  const [contextPopoverOpen, setContextPopoverOpen] = React.useState(false);

  return (
    <div className={cn("flex flex-col gap-1 rounded-md border-0 bg-background/40 px-2 py-1 shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent),2px_2px_4px_rgb(0_0_0/0.08)]", className)}>
      <div className="flex items-start gap-3">
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
        const reading = readContext({ totalTokens, contextLimit, contextUsage, contextLevelSignal });
        if (!reading) return null;
        const { tokens, pct, level, budgetPct } = reading;
        const color = METER_TEXT[level];

        return (
          <div className="flex flex-1 min-w-0 flex-col items-stretch gap-0.5">
            <HeaderLabel className="font-light lowercase whitespace-nowrap truncate">
              {controlsSummary || '\u00A0'}
            </HeaderLabel>
          <Popover
            open={contextPopoverOpen}
            onOpenChange={(next) => {
              setContextPopoverOpen(next);
              // Mark read on close, not open: clearing on open dropped the unread tints before they could be seen.
              if (!next) onSignalsRead?.();
            }}
            align="end"
            side="bottom"
            className="w-96"
            triggerClassName="relative block w-full"
            trigger={
              <button
                type="button"
                aria-label="Context usage"
                aria-expanded={contextPopoverOpen}
                className={cn(
                  "inline-flex w-full items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono font-medium cursor-pointer text-foreground",
                  "bg-background shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent)]",
                )}
              >
                <Database className="w-3.5 h-3.5 text-foreground" />
                <span className={cn("font-mono", color)}>
                  {formatContextTokens(tokens)}
                </span>
                {narrow && <InlineDivider data-testid="context-meter-divider" className="bg-current opacity-30" />}
                {!narrow && (
                <div data-testid="context-meter-bar" className="flex-1 min-w-11 h-1.5 bg-foreground/10 rounded-full overflow-hidden relative">
                  <div
                    className={cn("absolute inset-y-0 left-0 rounded-full transition-all", METER_FILL[level])}
                    style={{ width: `${pct}%` }}
                  />
                  {budgetPct > 0 && budgetPct < 100 && (
                    <div
                      className="absolute inset-y-0 w-px bg-foreground/50"
                      style={{ left: `${budgetPct}%` }}
                    />
                  )}
                </div>
                )}
                <span className="text-foreground font-mono">{pct.toFixed(0)}%</span>
              </button>
            }
            content={
              <SessionContextDetails
                reading={reading}
                sessionId={sessionId}
                pendingAction={pendingAction}
                recentEvents={recentEvents}
                onCompact={onCompact}
                compactDisabled={compactDisabled}
              />
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

      <ActivityPill signal={activitySignal} className="self-start" />
    </div>
  );
}
