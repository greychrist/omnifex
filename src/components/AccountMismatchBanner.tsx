import React from "react";
import { AlertTriangle, X, RotateCw } from "lucide-react";
import type { AccountMismatch } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface AccountMismatchBannerProps {
  mismatch: AccountMismatch | null;
  onDismiss: () => void;
  /**
   * Supplied only when restarting would actually change something — i.e. the
   * running CLI process holds the wrong credentials. Omitted when the
   * expectation was simply corrected, since the session is already fine.
   */
  onRestart?: (() => void) | null;
  /** True while the restart is in flight, to disable the button. */
  restarting?: boolean;
}

/**
 * Non-blocking warning shown when a session's config dir is authenticated as
 * somebody other than the account's recorded email — or as nobody at all.
 *
 * Deliberately informational: by the time this renders the session has already
 * started. Gating the launch behind a modal was considered and rejected — it
 * lands on a hot path and becomes reflex-dismissed. See
 * docs/superpowers/specs/2026-07-27-account-email-verification-design.md
 */
export const AccountMismatchBanner: React.FC<AccountMismatchBannerProps> = ({
  mismatch,
  onDismiss,
  onRestart,
  restarting = false,
}) => {
  if (!mismatch) return null;

  return (
    <div className="flex items-start gap-2 px-3 py-2 text-xs bg-amber-500/10 text-amber-600 dark:text-amber-400">
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
      <div className="flex-1">
        This session expects{" "}
        <span className="font-mono">{mismatch.expected}</span>, but{" "}
        <span className="font-mono">{mismatch.configDir}</span> is{" "}
        {mismatch.detected ? (
          <>
            signed in as <span className="font-mono">{mismatch.detected}</span>
          </>
        ) : (
          <>not signed in</>
        )}
        .
      </div>
      {onRestart && (
        <button
          type="button"
          onClick={onRestart}
          disabled={restarting}
          title="Stop this session's CLI process and start a fresh one, resuming the conversation. Needed because a re-login doesn't reach an already-running process."
          className="shrink-0 inline-flex items-center gap-1 rounded px-2 py-0.5 font-medium bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-50 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <RotateCw className={cn("h-3 w-3", restarting && "animate-spin")} />
          {restarting ? "Restarting…" : "Restart session"}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="shrink-0 opacity-60 hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};
