import React, { useState } from "react";
import { TrendingUp, Clock, PlugZap, X } from "lucide-react";
import { formatTokens } from "@/lib/contextPressure";
import { CACHE_TTL_1H_MS, type CacheTtlChange } from "@/lib/cacheExpiry";
import type { TurnDelta } from "@/lib/turnDelta";
import type { McpServerConfigError } from "@/types/jsonl";

export interface SessionNoticesProps {
  /** A single turn that grew context past the configured threshold. */
  jump: TurnDelta | null;
  /** The most recent effective-TTL change. */
  ttlChange: CacheTtlChange | null;
  /**
   * MCP servers the CLI skipped over a config problem, from system:init.
   * These never reach the MCP status panel — the CLI omits them from
   * `mcp_servers` entirely — so this banner is the only place they surface.
   */
  mcpErrors?: McpServerConfigError[] | null;
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
export const SessionNotices: React.FC<SessionNoticesProps> = ({ jump, ttlChange, mcpErrors }) => {
  const [dismissedJump, setDismissedJump] = useState<string | null>(null);
  const [dismissedTtl, setDismissedTtl] = useState<string | null>(null);
  const [dismissedMcp, setDismissedMcp] = useState<string | null>(null);

  const jumpKey = jump?.anchorId ?? null;
  // Stays until dismissed. It used to auto-clear once a later turn confirmed
  // the new TTL, which during a busy turn meant it vanished within seconds —
  // often before it had been read at all.
  const ttlKey = ttlChange ? `${ttlChange.fromMs}->${ttlChange.toMs}` : null;

  // Keyed on the set of skipped server names, same identity-not-boolean rule
  // as the notices above: fix one broken entry and the next re-init reports
  // whatever is still wrong instead of staying silent.
  const mcpKey = mcpErrors?.length ? mcpErrors.map((e) => e.name).join('|') : null;

  const showJump = jumpKey !== null && jumpKey !== dismissedJump;
  const showTtl = ttlKey !== null && ttlKey !== dismissedTtl;
  const showMcp = mcpKey !== null && mcpKey !== dismissedMcp;
  if (!showJump && !showTtl && !showMcp) return null;

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
      {showMcp && mcpErrors && (
        <div className={ROW}>
          <PlugZap className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="flex-1 space-y-0.5">
            <div>
              {mcpErrors.length === 1
                ? '1 MCP server was skipped'
                : `${mcpErrors.length} MCP servers were skipped`}{' '}
              — they are not available in this session.
            </div>
            {/* The CLI's own message names the offending field and the type it
                expected; paraphrasing would throw that away. */}
            {mcpErrors.map((e) => (
              <div key={e.name} className="opacity-80">
                <span className="font-mono">{e.name}</span>
                {e.message ? ` — ${e.message}` : ` — ${e.type}`}
              </div>
            ))}
          </div>
          <DismissButton
            label="Dismiss skipped MCP servers notice"
            onClick={() => setDismissedMcp(mcpKey)}
          />
        </div>
      )}
    </>
  );
};
