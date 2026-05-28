import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createAccountsService, type AccountsService } from '../services/accounts';
import {
  runFirstTimeDiscovery,
  nameFromConfigDir,
  discoverConfigDirs,
  engineFromDirName,
  type DiscoveredConfigDir,
} from '../services/first-run-discovery';

// ---------------------------------------------------------------------------
// First-time account discovery — runs once on Electron main boot when both
// `listAccounts()` is empty AND the `discovery_completed` flag is unset.
// Creates one engine-tagged Account row per `~/.claude*`/`~/.codex*` dir found,
// with no path rules (resolution still goes override → rule → null).
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

  const fakeDiscoverEmpty = async (): Promise<DiscoveredConfigDir[]> => [];
  const fakeDiscoverTwo = async (): Promise<DiscoveredConfigDir[]> => [
    { dirName: '.claude', configDir: '/home/user/.claude', engine: 'claude' },
    { dirName: '.codex-work', configDir: '/home/user/.codex-work', engine: 'codex' },
  ];

  it('creates one engine-tagged account per discovered config dir when nothing exists yet', async () => {
    const result = await runFirstTimeDiscovery({ accounts, db, discover: fakeDiscoverTwo });

    expect(result.ran).toBe(true);
    expect(result.created).toHaveLength(2);

    const list = accounts.listAccounts();
    expect(list).toHaveLength(2);
    const byName = Object.fromEntries(list.map((a) => [a.name, a]));
    expect(byName['Claude'].engine).toBe('claude');
    expect(byName['Work'].engine).toBe('codex');
    expect(byName['Work'].config_dir).toBe('/home/user/.codex-work');
  });

  it('sets discovery_completed=true after a run', async () => {
    expect(db.getSetting('discovery_completed')).toBeNull();

    await runFirstTimeDiscovery({ accounts, db, discover: fakeDiscoverTwo });

    expect(db.getSetting('discovery_completed')).toBe('true');
  });

  it('also sets discovery_completed when zero dirs are found', async () => {
    const result = await runFirstTimeDiscovery({ accounts, db, discover: fakeDiscoverEmpty });

    expect(result.ran).toBe(true);
    expect(result.created).toEqual([]);
    expect(db.getSetting('discovery_completed')).toBe('true');
  });

  it('does NOT run when accounts already exist', async () => {
    accounts.createAccount({ name: 'Existing', configDir: '/some/dir' });

    let discoverCalled = false;
    const result = await runFirstTimeDiscovery({
      accounts,
      db,
      discover: async () => {
        discoverCalled = true;
        return [{ dirName: '.claude', configDir: '/home/user/.claude', engine: 'claude' as const }];
      },
    });

    expect(result.ran).toBe(false);
    expect(discoverCalled).toBe(false);
    expect(accounts.listAccounts()).toHaveLength(1);
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
        return [{ dirName: '.claude', configDir: '/home/user/.claude', engine: 'claude' as const }];
      },
    });

    expect(result.ran).toBe(false);
    expect(discoverCalled).toBe(false);
    expect(accounts.listAccounts()).toHaveLength(0);
  });

  it('does not create path rules', async () => {
    await runFirstTimeDiscovery({ accounts, db, discover: fakeDiscoverTwo });

    expect(accounts.listPathRules()).toEqual([]);
    expect(accounts.resolve('/home/user/Repos/anything')).toEqual({ claude: null, codex: null });
  });

  it('handles a single .claude dir cleanly', async () => {
    const result = await runFirstTimeDiscovery({
      accounts,
      db,
      discover: async () => [{ dirName: '.claude', configDir: '/home/user/.claude', engine: 'claude' as const }],
    });

    expect(result.created).toEqual([{ name: 'Claude', configDir: '/home/user/.claude', engine: 'claude' }]);
    const list = accounts.listAccounts();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Claude');
  });
});

describe('discoverConfigDirs', () => {
  it('finds both ~/.claude* and ~/.codex* and tags each with the right engine', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-disc-'));
    fs.mkdirSync(path.join(home, '.claude'));
    fs.mkdirSync(path.join(home, '.claude-work'));
    fs.mkdirSync(path.join(home, '.codex'));
    fs.mkdirSync(path.join(home, '.codex-side_project'));
    fs.mkdirSync(path.join(home, '.claudette')); // false-positive guard
    fs.mkdirSync(path.join(home, '.codexample')); // false-positive guard
    fs.writeFileSync(path.join(home, '.codex-not-a-dir'), 'x'); // file, not dir

    const found = await discoverConfigDirs(home);
    const byDir = Object.fromEntries(found.map((f) => [f.dirName, f]));

    expect(byDir['.claude']).toMatchObject({ engine: 'claude' });
    expect(byDir['.claude-work']).toMatchObject({ engine: 'claude' });
    expect(byDir['.codex']).toMatchObject({ engine: 'codex' });
    expect(byDir['.codex-side_project']).toMatchObject({ engine: 'codex' });
    expect(byDir['.claudette']).toBeUndefined();
    expect(byDir['.codexample']).toBeUndefined();
    expect(byDir['.codex-not-a-dir']).toBeUndefined();

    fs.rmSync(home, { recursive: true, force: true });
  });

  it('returns [] for a non-existent home dir', async () => {
    expect(await discoverConfigDirs('/no/such/dir/omnifex-test')).toEqual([]);
  });
});

describe('engineFromDirName', () => {
  it('classifies exact and separated prefixes; rejects false positives', () => {
    expect(engineFromDirName('.claude')).toBe('claude');
    expect(engineFromDirName('.claude-work')).toBe('claude');
    expect(engineFromDirName('.claude_work')).toBe('claude');
    expect(engineFromDirName('.codex')).toBe('codex');
    expect(engineFromDirName('.codex-a')).toBe('codex');
    expect(engineFromDirName('.claudette')).toBeNull();
    expect(engineFromDirName('.codexample')).toBeNull();
    expect(engineFromDirName('.zshrc')).toBeNull();
  });
});

describe('nameFromConfigDir', () => {
  it('derives engine-aware names', () => {
    expect(nameFromConfigDir('.claude', 'claude')).toBe('Claude');
    expect(nameFromConfigDir('.claude-work', 'claude')).toBe('Work');
    expect(nameFromConfigDir('.claude-personal', 'claude')).toBe('Personal');
    expect(nameFromConfigDir('.claude-work-prod', 'claude')).toBe('Work Prod');
    expect(nameFromConfigDir('.codex', 'codex')).toBe('Codex');
    expect(nameFromConfigDir('.codex-work', 'codex')).toBe('Work');
    expect(nameFromConfigDir('.codex-side_project', 'codex')).toBe('Side Project');
  });
});
