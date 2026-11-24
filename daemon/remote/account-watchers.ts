// `sync()` must be called after every account mutation.

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
