import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createAccountsService, type AccountsService } from '../services/accounts';

describe('accounts service', () => {
  let db: Database;
  let accounts: AccountsService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    accounts = createAccountsService(db);
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  describe('CRUD', () => {
    it('creates and lists accounts', () => {
      accounts.createAccount('Personal', '/home/user/.claude', false, 'pro');
      accounts.createAccount('Work', '/home/user/.claude-work', false, 'team');

      const list = accounts.listAccounts();
      expect(list).toHaveLength(2);
      expect(list.map((a) => a.name)).toContain('Personal');
      expect(list.map((a) => a.name)).toContain('Work');
    });

    it('updates an account', () => {
      accounts.createAccount('Personal', '/home/user/.claude', false, 'pro');
      const [acct] = accounts.listAccounts();

      accounts.updateAccount(acct.id, 'Personal Updated', '/home/user/.claude-new', 'team');

      const updated = accounts.listAccounts().find((a) => a.id === acct.id)!;
      expect(updated.name).toBe('Personal Updated');
      expect(updated.config_dir).toBe('/home/user/.claude-new');
      expect(updated.account_type).toBe('team');
    });

    it('deletes an account', () => {
      accounts.createAccount('ToDelete', '/home/user/.claude', false, 'pro');
      const [acct] = accounts.listAccounts();

      accounts.deleteAccount(acct.id);

      expect(accounts.listAccounts()).toHaveLength(0);
    });

    it('enforces unique name constraint', () => {
      accounts.createAccount('Dup', '/home/user/.claude', false, 'pro');
      expect(() => {
        accounts.createAccount('Dup', '/home/user/.claude-2', false, 'pro');
      }).toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Path rules
  // -----------------------------------------------------------------------

  describe('path rules', () => {
    it('adds and lists path rules', () => {
      accounts.createAccount('Work', '/home/user/.claude-work', false, 'team');
      const [work] = accounts.listAccounts();

      accounts.addPathRule(work.id, '/home/user/work', 10);

      const rules = accounts.listPathRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].path_prefix).toBe('/home/user/work');
      expect(rules[0].account_name).toBe('Work');
      expect(rules[0].priority).toBe(10);
    });

    it('removes a path rule', () => {
      accounts.createAccount('Work', '/home/user/.claude-work', false, 'team');
      const [work] = accounts.listAccounts();
      accounts.addPathRule(work.id, '/home/user/work');

      const [rule] = accounts.listPathRules();
      accounts.removePathRule(rule.id);

      expect(accounts.listPathRules()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Resolution
  // -----------------------------------------------------------------------

  describe('resolution', () => {
    it('resolves via explicit project override', () => {
      accounts.createAccount('Default', '/home/user/.claude', true, 'pro');
      accounts.createAccount('Work', '/home/user/.claude-work', false, 'team');
      const [def, work] = accounts.listAccounts().sort((a, b) => a.name.localeCompare(b.name));

      accounts.setProjectOverride('/home/user/projects/myapp', work.id);

      const resolved = accounts.resolve('/home/user/projects/myapp');
      expect(resolved).not.toBeNull();
      expect(resolved!.id).toBe(work.id);
    });

    it('resolves via longest matching path rule', () => {
      accounts.createAccount('Work', '/home/user/.claude-work', false, 'team');
      accounts.createAccount('OSS', '/home/user/.claude-oss', false, 'pro');
      const [oss, work] = accounts.listAccounts().sort((a, b) => a.name.localeCompare(b.name));

      accounts.addPathRule(work.id, '/home/user/work', 0);
      accounts.addPathRule(oss.id, '/home/user/work/oss', 0);

      const resolved = accounts.resolve('/home/user/work/oss/myrepo');
      expect(resolved).not.toBeNull();
      expect(resolved!.id).toBe(oss.id);
    });

    it('returns null when no override or path rule matches (no default fallback)', () => {
      accounts.createAccount('Default', '/home/user/.claude', true, 'pro');
      accounts.createAccount('Work', '/home/user/.claude-work', false, 'team');

      const resolved = accounts.resolve('/home/user/personal/myrepo');
      expect(resolved).toBeNull();
    });

    it('returns null when nothing matches', () => {
      accounts.createAccount('Work', '/home/user/.claude-work', false, 'team');
      // no default, no rules

      const resolved = accounts.resolve('/home/user/personal/myrepo');
      expect(resolved).toBeNull();
    });

    it('path rule beats default account', () => {
      accounts.createAccount('Default', '/home/user/.claude', true, 'pro');
      accounts.createAccount('Work', '/home/user/.claude-work', false, 'team');
      const [def, work] = accounts.listAccounts().sort((a, b) => a.name.localeCompare(b.name));

      accounts.addPathRule(work.id, '/home/user/work', 0);

      const resolved = accounts.resolve('/home/user/work/myrepo');
      expect(resolved).not.toBeNull();
      expect(resolved!.id).toBe(work.id);
    });

    it('explicit override beats path rule', () => {
      accounts.createAccount('Work', '/home/user/.claude-work', false, 'team');
      accounts.createAccount('Special', '/home/user/.claude-special', false, 'pro');
      const [special, work] = accounts.listAccounts().sort((a, b) => a.name.localeCompare(b.name));

      accounts.addPathRule(work.id, '/home/user/work', 0);
      accounts.setProjectOverride('/home/user/work/myapp', special.id);

      const resolved = accounts.resolve('/home/user/work/myapp');
      expect(resolved).not.toBeNull();
      expect(resolved!.id).toBe(special.id);
    });
  });

  // -----------------------------------------------------------------------
  // Explain resolution
  // -----------------------------------------------------------------------

  describe('explain resolution', () => {
    it('explains override match', () => {
      accounts.createAccount('Work', '/home/user/.claude-work', false, 'team');
      const [work] = accounts.listAccounts();

      accounts.setProjectOverride('/home/user/projects/myapp', work.id);

      const explanation = accounts.explainResolution('/home/user/projects/myapp');
      expect(explanation).not.toBeNull();
      expect(explanation!.match_type).toBe('override');
      expect(explanation!.account.id).toBe(work.id);
    });

    it('explains path rule match', () => {
      accounts.createAccount('Work', '/home/user/.claude-work', false, 'team');
      const [work] = accounts.listAccounts();

      accounts.addPathRule(work.id, '/home/user/work', 5);

      const explanation = accounts.explainResolution('/home/user/work/myrepo');
      expect(explanation).not.toBeNull();
      expect(explanation!.match_type).toBe('path_rule');
      expect(explanation!.match_detail).toBe('/home/user/work');
      expect(explanation!.account.id).toBe(work.id);
    });
  });

  // -----------------------------------------------------------------------
  // Discovery
  // -----------------------------------------------------------------------

  describe('discovery', () => {
    it('returns an array', async () => {
      const discovered = await accounts.discoverAccounts();
      expect(Array.isArray(discovered)).toBe(true);
    });
  });
});
