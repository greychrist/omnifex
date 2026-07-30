import React from "react";
import { TrendingUp, Clock } from "lucide-react";
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

/**
 * One-line informational notices stacked under the context-pressure banner.
 *
 * Both are deliberately NOT actionable. The tempting wiring — click the jump
 * notice to run /compact — is wrong: a large single-turn jump is usually a
 * skill or file load that was just asked for, and compacting immediately would
 * discard it. These report; ContextPressureBanner is the one that acts.
 *
 * Neither carries a dismiss control either. Each self-clears from its own
 * data: the jump stops being the most recent delta once an ordinary turn
 * lands, and the TTL change goes stale once a later turn writes cache.
 */
export const SessionNotices: React.FC<SessionNoticesProps> = ({ jump, ttlChange }) => {
  const showTtl = ttlChange !== null && ttlChange.isMostRecentWrite;
  if (!jump && !showTtl) return null;

  return (
    <>
      {jump && (
        <div className="flex items-start gap-2 px-3 py-1.5 text-xs bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <TrendingUp className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span className="flex-1">
            Last turn added{" "}
            <span className="font-mono">{formatTokens(jump.deltaTokens)}</span> of
            context (<span className="font-mono">{formatTokens(jump.prevTotal)}</span>
            {" → "}
            <span className="font-mono">{formatTokens(jump.newTotal)}</span>).
          </span>
        </div>
      )}
      {showTtl && ttlChange && (
        <div className="flex items-start gap-2 px-3 py-1.5 text-xs bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <Clock className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span className="flex-1">
            Prompt cache TTL changed from{" "}
            <span className="font-mono">{ttlLabel(ttlChange.fromMs)}</span> to{" "}
            <span className="font-mono">{ttlLabel(ttlChange.toMs)}</span>
            {ttlChange.toMs < ttlChange.fromMs
              ? " — usually means usage overage."
              : "."}
          </span>
        </div>
      )}
    </>
  );
};
