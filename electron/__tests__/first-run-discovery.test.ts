import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createAccountsService, type AccountsService } from '../services/accounts';
import { runFirstTimeDiscovery, nameFromConfigDir } from '../services/first-run-discovery';

// ---------------------------------------------------------------------------
// First-time account discovery — runs once on Electron main boot when both
// `listAccounts()` is empty AND the `discovery_completed` flag is unset.
// Creates one Account row per `~/.claude*` dir found, with no path rules and
// no default-account flag (resolution still goes override → rule → null).
//
// Discovery is one-and-done by design: if the user later deletes all accounts
// in the UI, we don't silently re-create them on next launch.
// ---------------------------------------------------------------------------

describe('runFirstTimeDiscovery', () => {
  let db: Database;
  let accounts: AccountsService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    accounts = createAccountsService(db);
  });

  afterEach(() => {
    db.close();
  });

  const fakeDiscoverEmpty = async (): Promise<Array<[string, string]>> => [];
  const fakeDiscoverTwo = async (): Promise<Array<[string, string]>> => [
    ['.claude', '/home/user/.claude'],
    ['.claude-work', '/home/user/.claude-work'],
  ];

  it('creates one account per discovered config dir when nothing exists yet', async () => {
    const result = await runFirstTimeDiscovery({ accounts, db, discover: fakeDiscoverTwo });

    expect(result.ran).toBe(true);
    expect(result.created).toHaveLength(2);

    const list = accounts.listAccounts();
    expect(list).toHaveLength(2);
    const names = list.map((a) => a.name).sort();
    expect(names).toEqual(['Claude', 'Work']);
    const dirs = list.map((a) => a.config_dir).sort();
    expect(dirs).toEqual(['/home/user/.claude', '/home/user/.claude-work']);
  });

  it('sets discovery_completed=true after a run', async () => {
    expect(db.getSetting('discovery_completed')).toBeNull();

    await runFirstTimeDiscovery({ accounts, db, discover: fakeDiscoverTwo });

    expect(db.getSetting('discovery_completed')).toBe('true');
  });

  it('also sets discovery_completed when zero dirs are found', async () => {
    // No `~/.claude*` on the box — still a completed run; don't keep retrying.
    const result = await runFirstTimeDiscovery({ accounts, db, discover: fakeDiscoverEmpty });

    expect(result.ran).toBe(true);
    expect(result.created).toEqual([]);
    expect(db.getSetting('discovery_completed')).toBe('true');
  });

  it('does NOT run when accounts already exist', async () => {
    accounts.createAccount('Existing', '/some/dir', 'pro');

    let discoverCalled = false;
    const result = await runFirstTimeDiscovery({
      accounts,
      db,
      discover: async () => {
        discoverCalled = true;
        return [['.claude', '/home/user/.claude']];
      },
    });

    expect(result.ran).toBe(false);
    expect(discoverCalled).toBe(false);
    expect(accounts.listAccounts()).toHaveLength(1);
    // Should not set the flag — leaves room for the next migration scenario.
    expect(db.getSetting('discovery_completed')).toBeNull();
  });

  it('does NOT run when discovery_completed is already set, even with zero accounts', async () => {
    db.saveSetting('discovery_completed', 'true');

    let discoverCalled = false;
    const result = await runFirstTimeDiscovery({
      accounts,
      db,
      discover: async () => {
        discoverCalled = true;
        return [['.claude', '/home/user/.claude']];
      },
    });

    expect(result.ran).toBe(false);
    expect(discoverCalled).toBe(false);
    expect(accounts.listAccounts()).toHaveLength(0);
  });

  it('does not create a default-account flag or path rules', async () => {
    await runFirstTimeDiscovery({ accounts, db, discover: fakeDiscoverTwo });

    // No path rules — resolution still returns null for any project until
    // the user manually configures rules or per-project overrides.
    expect(accounts.listPathRules()).toEqual([]);
    expect(accounts.resolve('/home/user/Repos/anything')).toBeNull();
  });

  it('handles a single .claude dir cleanly', async () => {
    const result = await runFirstTimeDiscovery({
      accounts,
      db,
      discover: async () => [['.claude', '/home/user/.claude']],
    });

    expect(result.created).toEqual([{ name: 'Claude', configDir: '/home/user/.claude' }]);
    const list = accounts.listAccounts();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Claude');
  });
});

describe('nameFromConfigDir', () => {
  it('renders .claude as "Claude"', () => {
    expect(nameFromConfigDir('.claude')).toBe('Claude');
  });

  it('renders .claude-work as "Work"', () => {
    expect(nameFromConfigDir('.claude-work')).toBe('Work');
  });

  it('renders .claude-personal as "Personal"', () => {
    expect(nameFromConfigDir('.claude-personal')).toBe('Personal');
  });

  it('renders multi-word suffixes title-cased and space-separated', () => {
    expect(nameFromConfigDir('.claude-work-prod')).toBe('Work Prod');
    expect(nameFromConfigDir('.claude-side_project')).toBe('Side Project');
  });
});
