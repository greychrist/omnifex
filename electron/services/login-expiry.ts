/**
 * When each account's stored claude.ai sign-in ends.
 *
 * CLI 2.1.318 began reporting it (`loginExpiresAt` in `claude auth status`,
 * `credential_expires_at` on `claude -p` results). Before that, a lapsed
 * sign-in was only detected after a session had already stranded on it
 * (sessionAuthFailure). Knowing the date lets the status bar warn ahead.
 *
 * The answer costs a CLI spawn (~1s), and it changes only when someone signs
 * in, so it is cached per config dir for TTL_MS. A failed probe is not cached
 * and answers null: "could not tell" is not "this sign-in has no end".
 * `invalidate` is for a sign-in the daemon learns of (the identity watcher);
 * `refresh` is for one the client just performed.
 */

export interface LoginExpiry {
  /** ISO time the stored sign-in ends; null when the CLI reports none. */
  expiresAt: string | null;
  /** ISO time the CLI was asked. */
  checkedAt: string;
}

export interface LoginExpiryService {
  get(configDir: string, opts?: { refresh?: boolean }): Promise<LoginExpiry | null>;
  invalidate(configDir: string): void;
}

const TTL_MS = 6 * 60 * 60 * 1000;

export function createLoginExpiryService(deps: {
  probe(configDir: string): Promise<{ loginExpiresAt: string | null }>;
  now?: () => number;
}): LoginExpiryService {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { value: LoginExpiry; at: number }>();
  const inflight = new Map<string, Promise<LoginExpiry | null>>();

  function load(configDir: string): Promise<LoginExpiry | null> {
    const pending = inflight.get(configDir);
    if (pending) return pending;
    const p = (async () => {
      try {
        const status = await deps.probe(configDir);
        const at = now();
        const value: LoginExpiry = {
          expiresAt: status.loginExpiresAt,
          checkedAt: new Date(at).toISOString(),
        };
        cache.set(configDir, { value, at });
        return value;
      } catch {
        return null;
      } finally {
        inflight.delete(configDir);
      }
    })();
    inflight.set(configDir, p);
    return p;
  }

  return {
    async get(configDir, opts) {
      // Never let an empty dir fall through to the CLI's default ~/.claude.
      if (!configDir) return null;
      const hit = cache.get(configDir);
      if (!opts?.refresh && hit && now() - hit.at < TTL_MS) return hit.value;
      return load(configDir);
    },
    invalidate(configDir) {
      cache.delete(configDir);
    },
  };
}
