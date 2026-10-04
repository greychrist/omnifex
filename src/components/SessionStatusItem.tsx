import * as React from "react";
import { cn } from "@/lib/utils";
import { Atom } from "lucide-react";
import { Popover } from "@/components/ui/popover";
import type { TabWaitingFor } from "@/lib/tabWaitingFor";
import {
  SessionContextDetails,
  readContext,
  formatContextTokens,
  METER_TEXT,
  type ContextInputs,
  type SessionContextDetailsProps,
} from "./SessionContextDetails";

/**
 * The session widget as a status-bar readout: `session ready 157.1k (16%)`.
 *
 * Same label-then-value shape as `daemon live` and `turn 12s` beside it, and
 * the same popover the widget opens — `SessionContextDetails`, so the two
 * cannot disagree. Lives alongside the widget for now, so the two can be
 * compared before one of them goes.
 *
 * The state word is coloured text, not a badge: the sessions popover's
 * `Working` / `Ready` vocabulary and colours, at the bar's weight.
 */

type SessionState = "starting" | "closed" | "permission" | "question" | "working" | "ready";

const STATE_COLOR: Record<SessionState, string> = {
  starting: "text-amber-500",
  closed: "text-red-500",
  // Indigo and amber/emerald match TabStatusPopover's WAITING_COLOR and
  // PROMPT_COLOR, minus their backgrounds.
  permission: "text-indigo-300",
  question: "text-indigo-300",
  working: "text-amber-300",
  ready: "text-emerald-400",
};

/**
 * Process state first, then what the turn is doing. "ready" over a process
 * that has exited would be a lie, and "working" while it waits on you hides
 * the one thing worth acting on — the same override the sessions popover
 * applies.
 */
function sessionState(
  sessionStatus: "starting" | "active" | "ended" | undefined,
  promptStatus: "working" | "ready",
  waitingFor: TabWaitingFor,
): SessionState {
  if (sessionStatus === "ended") return "closed";
  if (sessionStatus === "starting") return "starting";
  if (waitingFor) return waitingFor;
  return promptStatus;
}

export interface SessionStatusItemProps
  extends ContextInputs,
    Omit<SessionContextDetailsProps, "reading"> {
  sessionStatus?: "starting" | "active" | "ended";
  promptStatus: "working" | "ready";
  waitingFor: TabWaitingFor;
  /** Called when the popover closes, so the caller can clear unread events. */
  onSignalsRead?: () => void;
}

export function SessionStatusItem({
  totalTokens,
  contextLimit,
  contextUsage,
  contextLevelSignal,
  sessionStatus,
  promptStatus,
  waitingFor,
  onSignalsRead,
  ...details
}: SessionStatusItemProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const reading = readContext({ totalTokens, contextLimit, contextUsage, contextLevelSignal });
  const state = sessionState(sessionStatus, promptStatus, waitingFor);

  const label = (
    <>
      <Atom className="h-3.5 w-3.5" />
      <span className="opacity-70">session</span>
      <span data-testid="session-item-status" className={STATE_COLOR[state]}>
        {state}
      </span>
    </>
  );

  // Nothing to open before the first usage arrives: the popover is about the
  // context window, and it would be empty.
  if (!reading) {
    return (
      <span className="inline-flex items-center gap-1">{label}</span>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // On close, as the widget does: clearing on open dropped the unread
        // tint before the rows could be read.
        if (!next) onSignalsRead?.();
      }}
      align="end"
      side="bottom"
      className="w-96"
      trigger={
        <button
          type="button"
          aria-label={`session ${state}, context ${reading.pct.toFixed(0)}%`}
          aria-expanded={open}
          className="flex items-center gap-1 rounded hover:bg-muted/60"
        >
          {label}
          <span
            data-testid="session-item-context"
            // Pulses when red, like the thinking readout, so a window at its
            // compaction boundary is noticed without opening anything.
            className={cn(METER_TEXT[reading.level], reading.level === "critical" && "animate-pulse")}
          >
            {formatContextTokens(reading.tokens)} ({reading.pct.toFixed(0)}%)
          </span>
        </button>
      }
      content={<SessionContextDetails reading={reading} {...details} />}
    />
  );
}
