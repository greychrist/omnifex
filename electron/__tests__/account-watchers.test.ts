import { describe, expect, it, vi } from 'vitest';
import { createAccountWatchers } from '../remote/account-watchers';

interface Acct { config_dir: string; engine: 'claude' | 'codex' }

function make(initial: Acct[]) {
  let accounts = initial;
  const disposed: string[] = [];
  const codexCallbacks = new Map<string, (status: unknown) => void>();
  const claudeCallbacks = new Map<string, () => void>();
  const deps = {
    listAccounts: () => accounts,
    watchCodexAuth: vi.fn((dir: string, cb: (status: unknown) => void) => {
      codexCallbacks.set(dir, cb);
      return { dispose: () => { disposed.push(`codex:${dir}`); } };
    }),
    watchClaudeIdentity: vi.fn((dir: string, cb: () => void) => {
      claudeCallbacks.set(dir, cb);
      return { dispose: () => { disposed.push(`claude:${dir}`); } };
    }),
    onCodexAuthChanged: vi.fn(),
    onIdentityChanged: vi.fn(),
  };
  const watchers = createAccountWatchers(deps);
  return {
    watchers,
    deps,
    disposed,
    codexCallbacks,
    claudeCallbacks,
    setAccounts: (next: Acct[]) => { accounts = next; },
  };
}

describe('account watchers', () => {
  it('watches each Claude account for identity and each Codex account for auth', () => {
    const { watchers, deps } = make([
      { config_dir: '/c1', engine: 'claude' },
      { config_dir: '/x1', engine: 'codex' },
    ]);
    watchers.sync();
    expect(deps.watchClaudeIdentity).toHaveBeenCalledWith('/c1', expect.any(Function));
    expect(deps.watchCodexAuth).toHaveBeenCalledWith('/x1', expect.any(Function));
    expect(deps.watchClaudeIdentity).toHaveBeenCalledTimes(1);
    expect(deps.watchCodexAuth).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a second sync over the same accounts starts nothing new', () => {
    const { watchers, deps } = make([{ config_dir: '/c1', engine: 'claude' }]);
    watchers.sync();
    watchers.sync();
    expect(deps.watchClaudeIdentity).toHaveBeenCalledTimes(1);
  });

  it('skips a Claude account with no config dir', () => {
    const { watchers, deps } = make([{ config_dir: '', engine: 'claude' }]);
    watchers.sync();
    expect(deps.watchClaudeIdentity).not.toHaveBeenCalled();
  });

  it('disposes the watcher of an account that went away', () => {
    const { watchers, disposed, setAccounts } = make([
      { config_dir: '/c1', engine: 'claude' },
      { config_dir: '/x1', engine: 'codex' },
    ]);
    watchers.sync();
    setAccounts([{ config_dir: '/x1', engine: 'codex' }]);
    watchers.sync();
    expect(disposed).toEqual(['claude:/c1']);
  });

  it('reports which config dir changed', () => {
    const { watchers, deps, codexCallbacks, claudeCallbacks } = make([
      { config_dir: '/c1', engine: 'claude' },
      { config_dir: '/x1', engine: 'codex' },
    ]);
    watchers.sync();
    claudeCallbacks.get('/c1')!();
    codexCallbacks.get('/x1')!({ authenticated: true });
    expect(deps.onIdentityChanged).toHaveBeenCalledWith('/c1');
    expect(deps.onCodexAuthChanged).toHaveBeenCalledWith('/x1', { authenticated: true });
  });

  it('disposes everything on shutdown, and a throwing dispose does not stop the rest', () => {
    const { watchers, deps, disposed } = make([
      { config_dir: '/c1', engine: 'claude' },
      { config_dir: '/c2', engine: 'claude' },
    ]);
    deps.watchClaudeIdentity.mockImplementationOnce(() => ({ dispose: () => { throw new Error('gone'); } }));
    watchers.sync();
    watchers.disposeAll();
    expect(disposed).toEqual(['claude:/c2']);
  });
});
