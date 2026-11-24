// readOauthIdentity is the hot path (session start, no spawn); probeAuthStatus spawns the CLI and never runs on session start.
// `oauthAccount` lingers after a logout, so only the probe tells logged-out from stale.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { LogEntry } from './logging';

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
  loginExpiresAt: string | null;
}

export interface ProbeDeps {
  resolveBinary: () => string | null;
  exec?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => string | Promise<string>;
}

const LOGGED_OUT: AuthStatus = {
  loggedIn: false,
  email: null,
  authMethod: null,
  apiProvider: null,
  orgName: null,
  subscriptionType: null,
  loginExpiresAt: null,
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Never throws: runs on session start and must not break a launch. */
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

/** Spawns a process: keep it off hot paths. */
export async function probeAuthStatus(configDir: string, deps: ProbeDeps): Promise<AuthStatus> {
  const bin = deps.resolveBinary();
  if (!bin) return LOGGED_OUT;

  const run =
    deps.exec ??
    ((b: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> =>
      new Promise((resolve, reject) => {
        execFile(b, args, { encoding: 'utf8', timeout: 10_000, env }, (err, stdout) => {
          // ExecFileException is an Omit<> intersection, which the rule cannot see is an Error.
          const error: Error | null = err;
          if (error) reject(error);
          else resolve(stdout);
        });
      }));

  let out: string;
  try {
    out = await run(bin, ['auth', 'status', '--json'], {
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
    loginExpiresAt: str(p.loginExpiresAt),
  };
}

const WATCH_DEBOUNCE_MS = 150;

/**
 * Watches the parent dir: `.claude.json` is rewritten by atomic rename, which detaches a file watcher.
 * Dedupes on the resulting email: macOS FSEvents names `.claude.json` for unrelated writes in the dir.
 */
export function watchOauthIdentity(
  configDir: string,
  onChange: () => void,
): { dispose(): void } {
  let timer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  let disposed = false;
  let lastEmail = readOauthIdentity(configDir)?.email ?? null;

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (disposed) return;
      const nextEmail = readOauthIdentity(configDir)?.email ?? null;
      if (nextEmail === lastEmail) return;
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

/** `unknown-account` and `unverified` stay distinct: only `unverified` is the user's choice; the other is a routing bug. */
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

/** The one definition of "verified"; a renderer copy would drift. */
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

/** No Gmail dot/plus normalization: addresses the user considers distinct must not compare equal. */
export function emailsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = (a ?? '').trim().toLowerCase();
  const nb = (b ?? '').trim().toLowerCase();
  if (!na || !nb) return false;
  return na === nb;
}

/** Cheap by construction (the `.claude.json` read, never a spawn): runs on every cold start. */
export function createAccountIdentityVerdict(deps: {
  accounts: {
    getAccountByConfigDir(configDir: string): { expected_email?: string | null } | null | undefined;
  };
  readIdentity?: (configDir: string) => { email: string | null } | null;
  log: { writeBatch(entries: LogEntry[]): void };
}): (configDir: string) => IdentityVerdict {
  const readIdentity = deps.readIdentity ?? readOauthIdentity;

  return (configDir: string): IdentityVerdict => {
    const account = deps.accounts.getAccountByConfigDir(configDir);
    const expected = account?.expected_email ?? null;
    // Read even with no expectation: it drives Sign in / Sign out. Detecting is not verifying.
    const detected = account ? (readIdentity(configDir)?.email ?? null) : null;
    const status = classifyIdentity({ accountExists: !!account, expected, detected });
    if (status === 'unknown-account') {
      // Say so: an unowned config dir would otherwise silently disable verification while looking clean.
      deps.log.writeBatch([{
        timestamp: new Date().toISOString(),
        level: 'warn',
        source: 'backend',
        category: 'account-identity',
        message: `identity check skipped: no account owns configDir=${configDir}`,
      }]);
    }
    return { status, expected, detected, configDir };
  };
}
