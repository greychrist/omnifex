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
  /** The window to size the gauge against, from resolveContextLimit in the
   *  parent — one computation, so the card and the pressure signals agree. */
  contextLimit: number;
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
  /** One-line rollup of the active controls ("Fable 5 | High | Auto Review"),
   *  rendered in thin small type above the context gauge so the live state is
   *  visible without opening the popover. */
  controlsSummary?: string | null;
  /** `session.activity` state signal — drives the usage-limit pill. */
  activitySignal?: SessionSignal;
  /** `context.level` state signal — drives the meter's colour and the
   *  compact-at readout. Falls back to an uncoloured meter when absent. */
  contextLevelSignal?: SessionSignal;
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
              // Reading happens on CLOSE, not on open. Opening is still what
              // counts as having read them — there is no separate "mark read"
              // control to forget — but clearing on open zeroed the badge and
              // dropped every row's unread tint before the reader could see
              // which rows the number had been pointing at.
              if (!next) onSignalsRead?.();
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
                <Database className="w-3.5 h-3.5 text-foreground" />
                <span className={cn("font-mono", color)}>
                  {formatContextTokens(tokens)}
                </span>
                {/* The bar is the first thing to go when the card has to
                    share a narrow row: the token count and the percentage
                    either side of it carry the same fact in less space. A rule
                    takes its place so those two numbers do not read as one. */}
                {narrow && <InlineDivider data-testid="context-meter-divider" className="bg-current opacity-30" />}
                {!narrow && (
                <div data-testid="context-meter-bar" className="flex-1 min-w-11 h-1.5 bg-foreground/10 rounded-full overflow-hidden relative">
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

      {/* The usage-limit pill, when there is one. The turn clock, the thinking burst, the
          cache countdown and the running-subagent count used to live here
          too; they are facts about the conversation rather than the session,
          so they moved to the chat status bar above the transcript, where
          they stay readable without this widget open. */}
      <ActivityPill signal={activitySignal} className="self-start" />
    </div>
  );
}
