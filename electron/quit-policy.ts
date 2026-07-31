/**
 * Whether a quit may proceed, or needs the user to confirm first.
 *
 * OmniFex quits when its last window closes rather than lingering in the Dock
 * the way a stock Electron app does on macOS — leaving it resident got it
 * reported as "running in the background". The cost of that is that closing a
 * window now ends any Claude session mid-turn, so a quit that would kill work
 * asks first.
 *
 * Pure so the rule is testable without an Electron app instance; main.ts owns
 * the dialog and the event plumbing.
 */

export interface QuitPrompt {
  message: string;
  detail: string;
}

export type QuitDecision = { action: 'allow' } | { action: 'confirm'; prompt: QuitPrompt };

export interface QuitPolicyInput {
  /** Sessions genuinely mid-turn — not ones paused on a permission prompt. */
  workingCount: number;
  /**
   * True for a quit the user has already agreed to: the second half of the
   * update install, or a confirmation they just gave. Never re-questioned,
   * because cancelling an install-driven quit would strand the update.
   */
  authorized: boolean;
}

export function decideQuit({ workingCount, authorized }: QuitPolicyInput): QuitDecision {
  if (authorized) return { action: 'allow' };
  // `>= 1` rather than `> 0` so NaN — which loses every comparison — falls
  // through to allow. The count comes from a live aggregator that can report
  // from a window already being torn down.
  if (!(workingCount >= 1)) return { action: 'allow' };

  return {
    action: 'confirm',
    prompt: {
      message:
        workingCount === 1
          ? '1 session is still working.'
          : `${workingCount} sessions are still working.`,
      detail: 'Quitting OmniFex will stop them.',
    },
  };
}
