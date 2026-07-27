import type { IdentityStatus, IdentityVerdict } from "@/lib/api";

export interface SessionVerification {
  /** What the shield shows. */
  status: IdentityStatus;
  /**
   * True when the RUNNING CLI process holds credentials for the wrong account.
   * Re-logging in does not fix an already-spawned process, so this is the only
   * state where restarting the session actually changes anything.
   */
  needsRestart: boolean;
  expected: string | null;
  /** The address we compared against — the session's own, when it has one. */
  detected: string | null;
}

function normalize(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

/**
 * Decide what a live session should say about its account identity.
 *
 * The key distinction: a mismatch can mean two very different things.
 *
 *   - The EXPECTATION was wrong (the user corrected the email, and it now
 *     matches what the session is genuinely running as). Nothing is broken;
 *     go green and never ask for a restart.
 *   - The SESSION is wrong (the running process is authenticated as someone
 *     else). A re-login can't reach an already-spawned CLI, so this is the
 *     case that warrants a restart.
 *
 * Telling them apart requires the session's OWN identity — the `account.email`
 * the CLI reports in `system:init` — not the config-dir file, which describes
 * the world as it is now rather than as the session started. When the session
 * reports one, it wins outright.
 *
 * TUI sessions produce no init payload, so `sessionEmail` is null there and we
 * fall back to the config-dir verdict. That can't distinguish the two cases,
 * so a mismatch conservatively offers a restart.
 */
export function resolveSessionVerification(opts: {
  verdict: IdentityVerdict | null;
  /** From `system:init`; null in TUI mode or before init lands. */
  sessionEmail: string | null;
  loaded: boolean;
  error: boolean;
}): SessionVerification | null {
  const { verdict, sessionEmail, loaded, error } = opts;

  // A failed read is not evidence about account state, but it IS worth
  // surfacing — it must not read as a clean pass.
  if (error) {
    return { status: "unknown-account", needsRestart: false, expected: null, detected: null };
  }
  if (!loaded || !verdict) return null;
  if (verdict.status === "unverified") return null;
  if (verdict.status === "unknown-account") {
    return {
      status: "unknown-account",
      needsRestart: false,
      expected: verdict.expected,
      detected: verdict.detected,
    };
  }

  const expected = verdict.expected;
  if (!expected) return null;

  if (sessionEmail !== null) {
    const matches = normalize(expected) === normalize(sessionEmail);
    return {
      status: matches ? "verified" : "mismatch",
      needsRestart: !matches,
      expected,
      detected: sessionEmail,
    };
  }

  // No session identity available (TUI). Fall back to the config dir, and
  // assume a restart is needed on any failure — the safe direction.
  return {
    status: verdict.status,
    needsRestart: verdict.status === "mismatch" || verdict.status === "signed-out",
    expected,
    detected: verdict.detected,
  };
}
