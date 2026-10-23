/**
 * File watchers that keep sign-in state honest across clients.
 *
 * A logout or login done outside OmniFex — in a terminal — changes the
 * account's credentials on disk and nothing else. Without a watcher the
 * verification badge stays red (or green) until something remounts. So the
 * daemon watches each Claude account's `.claude.json` for an identity change
 * and each Codex account's `auth.json`, and tells every client which config
 * dir changed (`account-identity-changed` / `codex-auth-status-changed`).
 *
 * This lived in Electron main, which meant the iPad never heard about it and
 * the watchers stopped whenever the window was closed. The account list
 * changes under it, so `sync()` is called after every account mutation:
 * watchers for new accounts start, watchers for removed ones stop.
 */

interface WatchedAccount {
  config_dir: string;
  engine: string;
}

interface Disposable {
  dispose(): void;
}

export interface AccountWatchersDeps {
  listAccounts(): WatchedAccount[];
  watchCodexAuth(configDir: string, onChange: (status: unknown) => void): Disposable;
  watchClaudeIdentity(configDir: string, onChange: () => void): Disposable;
  onCodexAuthChanged(configDir: string, status: unknown): void;
  onIdentityChanged(configDir: string): void;
}

export interface AccountWatchers {
  /** Bring the watcher set in line with the current account list. */
  sync(): void;
  disposeAll(): void;
}

function disposeQuietly(sub: Disposable): void {
  try {
    sub.dispose();
  } catch {
    // Best effort: a watcher whose directory vanished may throw on close.
  }
}

export function createAccountWatchers(deps: AccountWatchersDeps): AccountWatchers {
  const codex = new Map<string, Disposable>();
  const claude = new Map<string, Disposable>();

  function reconcile(
    watchers: Map<string, Disposable>,
    wanted: Set<string>,
    start: (dir: string) => Disposable,
  ): void {
    for (const [dir, sub] of watchers) {
      if (wanted.has(dir)) continue;
      disposeQuietly(sub);
      watchers.delete(dir);
    }
    for (const dir of wanted) {
      if (!watchers.has(dir)) watchers.set(dir, start(dir));
    }
  }

  return {
    sync() {
      const accounts = deps.listAccounts();
      const dirsFor = (engine: string) =>
        new Set(accounts.filter((a) => a.engine === engine && a.config_dir).map((a) => a.config_dir));
      reconcile(codex, dirsFor('codex'), (dir) =>
        deps.watchCodexAuth(dir, (status) => { deps.onCodexAuthChanged(dir, status); }),
      );
      reconcile(claude, dirsFor('claude'), (dir) =>
        deps.watchClaudeIdentity(dir, () => { deps.onIdentityChanged(dir); }),
      );
    },

    disposeAll() {
      for (const sub of [...codex.values(), ...claude.values()]) disposeQuietly(sub);
      codex.clear();
      claude.clear();
    },
  };
}
