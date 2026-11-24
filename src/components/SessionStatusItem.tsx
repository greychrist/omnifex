import * as React from "react";
import { ReadoutLabel } from '@/components/ui/readout-label';
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

type SessionState = "starting" | "closed" | "permission" | "question" | "working" | "ready";

const STATE_COLOR: Record<SessionState, string> = {
  starting: "text-amber-500",
  closed: "text-red-500",
  // Matches TabStatusPopover's WAITING_COLOR / PROMPT_COLOR.
  permission: "text-indigo-300",
  question: "text-indigo-300",
  working: "text-amber-300",
  ready: "text-emerald-400",
};

/** Process state outranks waiting, which outranks the turn — the sessions popover's override. */
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
      <ReadoutLabel>session</ReadoutLabel>
      <span data-testid="session-item-status" className={STATE_COLOR[state]}>
        {state}
      </span>
    </>
  );

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
        // Clear on close: clearing on open dropped the unread tint before the rows could be read.
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
            className={cn(METER_TEXT[reading.level], reading.level === "critical" && "animate-pulse")}
          >
            {formatContextTokens(reading.tokens)} ({reading.pct.toFixed(0)}%)
          </span>
        </button>
      }
      content={
        <SessionContextDetails
          reading={reading}
          {...details}
          onJumpToMessage={details.onJumpToMessage && ((uuid) => {
            setOpen(false);
            onSignalsRead?.();
            details.onJumpToMessage?.(uuid);
          })}
        />
      }
    />
  );
}
