import type { IdentityStatus, IdentityVerdict } from "@/lib/api";

export interface SessionVerification {
  status: IdentityStatus;
  /** A re-login cannot reach an already-spawned CLI; only this state makes a restart change anything. */
  needsRestart: boolean;
  expected: string | null;
  detected: string | null;
}

function normalize(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

/** The session's own `system:init` email wins over the config-dir verdict, which describes now, not the session's start. */
export function resolveSessionVerification(opts: {
  verdict: IdentityVerdict | null;
  sessionEmail: string | null;
  loaded: boolean;
  error: boolean;
}): SessionVerification | null {
  const { verdict, sessionEmail, loaded, error } = opts;

  // A failed read must not read as a clean pass.
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

  return {
    status: verdict.status,
    needsRestart: verdict.status === "mismatch" || verdict.status === "signed-out",
    expected,
    detected: verdict.detected,
  };
}
