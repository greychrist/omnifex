// Account identity — "who is actually logged in to this config dir?"
//
// OmniFex routes projects to accounts by config dir, but nothing in that chain
// verifies the config dir is authenticated as the account we think it is. A dir
// can be silently re-authed as somebody else, or logged out, and a session will
// still launch against it. This module supplies the ground truth for that check.
//
// Two operations, deliberately different costs:
//
//   readOauthIdentity  — reads <configDir>/.claude.json. Instant, no spawn.
//                        This is the HOT PATH: it runs on session start.
//   probeAuthStatus    — spawns `claude auth status --json`. Authoritative
//                        (~1s). Only ever runs behind an explicit user action
//                        in Settings. Never on session start.
//
// `oauthAccount` lingers in .claude.json after a logout, so the cheap read
// detects the wrong-account case reliably but the logged-out case only
// sometimes. That's why Settings also offers the probe: it is the CLI's own
// answer, and it distinguishes logged-out from stale.
//
// No Electron imports and no DB access — callers inject everything, so this
// module is directly unit-testable.
//
// See docs/superpowers/specs/2026-07-27-account-email-verification-design.md

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface OauthIdentity {
  email: string | null;
  displayName: string | null;
  organizationName: string | null;
  organizationType: string | null;
}

export interface AuthStatus {
  loggedIn: boolean;
  email: string | null;
  authMethod: string | null;
  apiProvider: string | null;
  orgName: string | null;
  subscriptionType: string | null;
}

export interface ProbeDeps {
  /** Resolves the `claude` binary. Null when none can be found. */
  resolveBinary: () => string | null;
  /** Injectable for tests. Defaults to execFileSync with a 10s timeout. */
  exec?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => string;
}

const LOGGED_OUT: AuthStatus = {
  loggedIn: false,
  email: null,
  authMethod: null,
  apiProvider: null,
  orgName: null,
  subscriptionType: null,
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Read the OAuth identity cached in `<configDir>/.claude.json`. Returns null
 * for every failure shape — missing dir, missing file, malformed JSON, or a
 * file with no `oauthAccount` (which is what a logged-out dir looks like on a
 * fresh install). Never throws: this runs on the session-start path and must
 * not be able to break a launch.
 */
export function readOauthIdentity(configDir: string): OauthIdentity | null {
  if (!configDir) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const acct = (parsed as Record<string, unknown>).oauthAccount;
  if (!acct || typeof acct !== 'object') return null;
  const a = acct as Record<string, unknown>;
  return {
    email: str(a.emailAddress),
    displayName: str(a.displayName),
    organizationName: str(a.organizationName),
    organizationType: str(a.organizationType),
  };
}

/**
 * Ask the CLI directly. `claude auth status --json` honors CLAUDE_CONFIG_DIR,
 * so this reports the identity for exactly the dir we pass. Costs a process
 * spawn — callers must keep it off hot paths.
 */
export function probeAuthStatus(configDir: string, deps: ProbeDeps): AuthStatus {
  const bin = deps.resolveBinary();
  if (!bin) return LOGGED_OUT;

  const run =
    deps.exec ??
    ((b: string, args: string[], env: NodeJS.ProcessEnv): string =>
      execFileSync(b, args, { encoding: 'utf8', timeout: 10_000, env }));

  let out: string;
  try {
    out = run(bin, ['auth', 'status', '--json'], {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
    });
  } catch {
    return LOGGED_OUT;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return LOGGED_OUT;
  }
  if (!parsed || typeof parsed !== 'object') return LOGGED_OUT;

  const p = parsed as Record<string, unknown>;
  return {
    loggedIn: p.loggedIn === true,
    email: str(p.email),
    authMethod: str(p.authMethod),
    apiProvider: str(p.apiProvider),
    orgName: str(p.orgName),
    subscriptionType: str(p.subscriptionType),
  };
}

/** Coalesce bursts — an atomic rewrite lands as several fs events. */
const WATCH_DEBOUNCE_MS = 150;

/**
 * Call `onChange` when the account signed into `<configDir>` actually changes,
 * so a logout / login performed outside OmniFex (in a terminal, say) updates
 * the UI without the user hunting for a refresh button.
 *
 * Two non-obvious constraints, both learned the hard way:
 *
 * 1. Watches the PARENT DIRECTORY, not the file. The CLI — and OmniFex's own
 *    scratch-cwd helper — rewrite `.claude.json` atomically (write `.tmp`,
 *    then rename), which detaches a file-targeted watcher after the first
 *    change. Same reasoning as the Codex auth watcher in auth/codex-auth.ts.
 *
 * 2. Dedupes on the RESULTING EMAIL, not on the event's filename. macOS
 *    FSEvents names `.claude.json` in the stream even when an unrelated file
 *    in the same directory was written, so filename filtering cannot be
 *    load-bearing. Comparing the parsed identity is platform-independent and
 *    is the guarantee callers actually want: fire only on a real change.
 *
 * Never throws: an unwatchable dir yields a disposable no-op.
 */
export function watchOauthIdentity(
  configDir: string,
  onChange: () => void,
): { dispose(): void } {
  let timer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  let disposed = false;
  // Snapshot at attach time so the first real change is detectable.
  let lastEmail = readOauthIdentity(configDir)?.email ?? null;

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (disposed) return;
      const nextEmail = readOauthIdentity(configDir)?.email ?? null;
      if (nextEmail === lastEmail) return; // noise, not a change
      lastEmail = nextEmail;
      try {
        onChange();
      } catch {
        // A bad subscriber must not kill the watcher.
      }
    }, WATCH_DEBOUNCE_MS);
  };

  try {
    watcher = fs.watch(configDir, (_event, filename) => {
      if (disposed) return;
      // Cheap pre-filter — meaningful on Linux/Windows, unreliable on macOS
      // (see note 2), which is why `schedule` re-checks by value anyway.
      if (filename === null || filename === '.claude.json') schedule();
    });
    watcher.on('error', () => { /* directory vanished; stay quiet */ });
  } catch {
    watcher = null;
  }

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (watcher) {
        try { watcher.close(); } catch { /* best-effort */ }
        watcher = null;
      }
    },
  };
}

/**
 * The verdict of an identity check, as a closed set.
 *
 * `unknown-account` and `unverified` are deliberately distinct. Both mean "no
 * comparison happened", but only `unverified` is a choice the user made — the
 * other means a config dir is in play that no account row owns, which is a
 * routing or path-normalization bug. Collapsing them lets a broken check
 * masquerade as a deliberate opt-out, which is exactly the failure mode this
 * feature exists to prevent.
 */
export type IdentityStatus =
  | 'verified'
  | 'mismatch'
  | 'signed-out'
  | 'unverified'
  | 'unknown-account';

export interface IdentityVerdict {
  status: IdentityStatus;
  expected: string | null;
  detected: string | null;
  configDir: string;
}

/**
 * The single comparison used by every surface — the session pre-flight check,
 * the post-init re-check, the Settings row, and the session badge. Kept pure
 * and exported so there is exactly one definition of what "verified" means;
 * a second copy in the renderer would drift.
 */
export function classifyIdentity(opts: {
  accountExists: boolean;
  expected: string | null | undefined;
  detected: string | null | undefined;
}): IdentityStatus {
  if (!opts.accountExists) return 'unknown-account';
  const expected = (opts.expected ?? '').trim();
  if (!expected) return 'unverified';
  const detected = (opts.detected ?? '').trim();
  if (!detected) return 'signed-out';
  return emailsMatch(expected, detected) ? 'verified' : 'mismatch';
}

/**
 * Trimmed, case-insensitive comparison. Deliberately does NOT normalize Gmail
 * dots or plus-addressing: two addresses the user considers distinct must not
 * silently compare equal, or the check stops being a check.
 */
export function emailsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = (a ?? '').trim().toLowerCase();
  const nb = (b ?? '').trim().toLowerCase();
  if (!na || !nb) return false;
  return na === nb;
}
