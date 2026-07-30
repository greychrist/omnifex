import React, { useState } from "react";
import { TrendingUp, Clock, X } from "lucide-react";
import { formatTokens } from "@/lib/contextPressure";
import { CACHE_TTL_1H_MS, type CacheTtlChange } from "@/lib/cacheExpiry";
import type { TurnDelta } from "@/lib/turnDelta";

export interface SessionNoticesProps {
  /** A single turn that grew context past the configured threshold. */
  jump: TurnDelta | null;
  /** The most recent effective-TTL change. */
  ttlChange: CacheTtlChange | null;
}

const ttlLabel = (ms: number) => (ms === CACHE_TTL_1H_MS ? '1h' : '5m');

const ROW =
  "flex items-start gap-2 px-3 py-2 text-xs bg-amber-500/10 text-amber-600 dark:text-amber-400";

const DismissButton: React.FC<{ label: string; onClick: () => void }> = ({
  label,
  onClick,
}) => (
  <button
    type="button"
    aria-label={label}
    onClick={onClick}
    className="shrink-0 opacity-60 hover:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
  >
    <X className="h-3.5 w-3.5" />
  </button>
);

/**
 * Informational banners stacked under the context-pressure banner, styled after
 * AccountMismatchBanner: report, offer an X, get out of the way.
 *
 * Neither is actionable beyond dismissal. The tempting wiring — click the jump
 * notice to run /compact — is wrong: a large jump is usually a skill or file
 * load that was just asked for, and compacting immediately would discard it.
 * ContextPressureBanner is the one that acts.
 *
 * Dismissal is keyed to the *identity* of what is being reported rather than a
 * boolean, so waving off one jump never suppresses the next one. That is also
 * why the state needs no reset effect: a new `anchorId` simply doesn't match
 * the recorded key.
 */
export const SessionNotices: React.FC<SessionNoticesProps> = ({ jump, ttlChange }) => {
  const [dismissedJump, setDismissedJump] = useState<string | null>(null);
  const [dismissedTtl, setDismissedTtl] = useState<string | null>(null);

  const jumpKey = jump?.anchorId ?? null;
  const ttlKey =
    ttlChange && ttlChange.isMostRecentWrite
      ? `${ttlChange.fromMs}->${ttlChange.toMs}`
      : null;

  const showJump = jumpKey !== null && jumpKey !== dismissedJump;
  const showTtl = ttlKey !== null && ttlKey !== dismissedTtl;
  if (!showJump && !showTtl) return null;

  return (
    <>
      {showJump && jump && (
        <div className={ROW}>
          <TrendingUp className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span className="flex-1">
            This prompt has added{" "}
            <span className="font-mono">{formatTokens(jump.deltaTokens)}</span> of
            context (<span className="font-mono">{formatTokens(jump.prevTotal)}</span>
            {" → "}
            <span className="font-mono">{formatTokens(jump.newTotal)}</span>).
          </span>
          <DismissButton
            label="Dismiss context jump notice"
            onClick={() => setDismissedJump(jumpKey)}
          />
        </div>
      )}
      {showTtl && ttlChange && (
        <div className={ROW}>
          <Clock className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span className="flex-1">
            Prompt cache TTL changed from{" "}
            <span className="font-mono">{ttlLabel(ttlChange.fromMs)}</span> to{" "}
            <span className="font-mono">{ttlLabel(ttlChange.toMs)}</span>
            {ttlChange.toMs < ttlChange.fromMs
              ? " — usually means usage overage."
              : "."}
          </span>
          <DismissButton
            label="Dismiss cache TTL notice"
            onClick={() => setDismissedTtl(ttlKey)}
          />
        </div>
      )}
    </>
  );
};
