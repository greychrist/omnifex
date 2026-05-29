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
      accounts.createAccount({ name: 'Personal', configDir: '/home/user/.claude' });
      accounts.createAccount({ name: 'Work', configDir: '/home/user/.claude-work', subscriptionLabel: 'team' });

      const list = accounts.listAccounts();
      expect(list).toHaveLength(2);
      expect(list.map((a) => a.name)).toContain('Personal');
      expect(list.map((a) => a.name)).toContain('Work');
    });

    it('round-trips engine, subscription_label, has_cost on create', () => {
      const created = accounts.createAccount({
        name: 'CodexWork',
        configDir: '/x',
        engine: 'codex',
        subscriptionLabel: 'Plus',
        hasCost: true,
      });
      expect(created.engine).toBe('codex');
      expect(created.subscription_label).toBe('Plus');
      expect(created.has_cost).toBe(true);

      const reread = accounts.listAccounts().find((a) => a.id === created.id)!;
      expect(reread).toMatchObject({ engine: 'codex', subscription_label: 'Plus', has_cost: true });
    });

    it('defaults engine=claude, subscription_label="", has_cost=true when not specified', () => {
      const created = accounts.createAccount({ name: 'A', configDir: '/A' });
      expect(created.engine).toBe('claude');
      expect(created.subscription_label).toBe('');
      expect(created.has_cost).toBe(true);
    });

    it('persists has_cost=false', () => {
      const created = accounts.createAccount({ name: 'Maxer', configDir: '/m', subscriptionLabel: 'Max', hasCost: false });
      expect(created.has_cost).toBe(false);
      const reread = accounts.listAccounts().find((a) => a.id === created.id)!;
      expect(reread.has_cost).toBe(false);
    });

    it('updates an account', () => {
      accounts.createAccount({ name: 'Personal', configDir: '/home/user/.claude' });
      const [acct] = accounts.listAccounts();

      accounts.updateAccount(acct.id, {
        name: 'Personal Updated',
        configDir: '/home/user/.claude-new',
        subscriptionLabel: 'team',
      });

      const updated = accounts.listAccounts().find((a) => a.id === acct.id)!;
      expect(updated.name).toBe('Personal Updated');
      expect(updated.config_dir).toBe('/home/user/.claude-new');
      expect(updated.subscription_label).toBe('team');
    });

    it('preserves subscription_label and has_cost when update omits them', () => {
      const created = accounts.createAccount({ name: 'P', configDir: '/p', subscriptionLabel: 'Pro', hasCost: false });
      accounts.updateAccount(created.id, { name: 'P2', configDir: '/p' });
      const updated = accounts.listAccounts().find((a) => a.id === created.id)!;
      expect(updated.subscription_label).toBe('Pro');
      expect(updated.has_cost).toBe(false);
    });

    it('round-trips cli_path through createAccount', () => {
      accounts.createAccount({ name: 'Personal', configDir: '/home/user/.claude', subscriptionLabel: 'Max', cliPath: '/Users/g/.local/bin/claude' });
      const [acct] = accounts.listAccounts();
      expect(acct.cli_path).toBe('/Users/g/.local/bin/claude');
    });

    it('round-trips cli_path through updateAccount', () => {
      const created = accounts.createAccount({ name: 'Personal', configDir: '/home/user/.claude', cliPath: '/initial/claude' });
      accounts.updateAccount(created.id, { name: 'Personal', configDir: '/home/user/.claude', cliPath: '/updated/claude' });
      const after = accounts.listAccounts().find((a) => a.id === created.id)!;
      expect(after.cli_path).toBe('/updated/claude');
    });

    it('clears cli_path when updateAccount is called with null', () => {
      const created = accounts.createAccount({ name: 'Personal', configDir: '/home/user/.claude', cliPath: '/initial/claude' });
      accounts.updateAccount(created.id, { name: 'Personal', configDir: '/home/user/.claude', cliPath: null });
      const after = accounts.listAccounts().find((a) => a.id === created.id)!;
      expect(after.cli_path).toBeNull();
    });

    it('defaults cli_path to null on createAccount when not provided', () => {
      accounts.createAccount({ name: 'Work', configDir: '/home/user/.claude-work' });
      const [acct] = accounts.listAccounts();
      expect(acct.cli_path).toBeNull();
    });

    it('stores and returns session_defaults on create', () => {
      accounts.createAccount({
        name: 'Personal',
        configDir: '/home/user/.claude',
        sessionDefaults: { model: 'sonnet', thinkingConfig: 'disabled', permissionMode: 'acceptEdits' },
      });
      const [acct] = accounts.listAccounts();
      expect(acct.session_defaults).toEqual({
        model: 'sonnet',
        thinkingConfig: 'disabled',
        permissionMode: 'acceptEdits',
      });
    });

    it('stores and returns session_defaults on update', () => {
      const created = accounts.createAccount({ name: 'Personal', configDir: '/home/user/.claude' });

      accounts.updateAccount(created.id, {
        name: 'Personal',
        configDir: '/home/user/.claude',
        sessionDefaults: { model: 'opus[1m]', thinkingConfig: 'adaptive', permissionMode: 'default' },
      });

      const updated = accounts.listAccounts().find((a) => a.id === created.id)!;
      expect(updated.session_defaults).toEqual({
        model: 'opus[1m]',
        thinkingConfig: 'adaptive',
        permissionMode: 'default',
      });
    });

    it('preserves existing session_defaults when update omits them', () => {
      const created = accounts.createAccount({ name: 'Personal', configDir: '/home/user/.claude', sessionDefaults: { model: 'sonnet' } });

      accounts.updateAccount(created.id, { name: 'Personal Renamed', configDir: '/home/user/.claude' });

      const updated = accounts.listAccounts().find((a) => a.id === created.id)!;
      expect(updated.session_defaults).toEqual({ model: 'sonnet' });
    });

    it("normalizes a legacy 'budget' thinkingConfig in stored session_defaults to 'adaptive' on read", () => {
      const created = accounts.createAccount({ name: 'Legacy', configDir: '/home/user/.claude' });
      const legacyJson = JSON.stringify({ model: 'sonnet', thinkingConfig: 'budget', permissionMode: 'default' });
      db.raw.prepare('UPDATE accounts SET session_defaults = ? WHERE id = ?').run(legacyJson, created.id);

      const reloaded = accounts.listAccounts().find((a) => a.id === created.id)!;
      expect(reloaded.session_defaults).toEqual({ model: 'sonnet', thinkingConfig: 'adaptive', permissionMode: 'default' });
    });

    it('strips an unknown thinkingConfig value rather than passing it through', () => {
      const created = accounts.createAccount({ name: 'Garbage', configDir: '/home/user/.claude' });
      const garbageJson = JSON.stringify({ thinkingConfig: 'totally-unknown' });
      db.raw.prepare('UPDATE accounts SET session_defaults = ? WHERE id = ?').run(garbageJson, created.id);

      const reloaded = accounts.listAccounts().find((a) => a.id === created.id)!;
      expect(reloaded.session_defaults?.thinkingConfig).toBeUndefined();
    });

    it('clears session_defaults when explicitly set to null', () => {
      const created = accounts.createAccount({ name: 'Personal', configDir: '/home/user/.claude', sessionDefaults: { model: 'sonnet' } });

      accounts.updateAccount(created.id, { name: 'Personal', configDir: '/home/user/.claude', sessionDefaults: null });

      const updated = accounts.listAccounts().find((a) => a.id === created.id)!;
      expect(updated.session_defaults).toBeUndefined();
    });

    it('deletes an account', () => {
      accounts.createAccount({ name: 'ToDelete', configDir: '/home/user/.claude' });
      const [acct] = accounts.listAccounts();

      accounts.deleteAccount(acct.id);

      expect(accounts.listAccounts()).toHaveLength(0);
    });

    it('enforces unique name constraint', () => {
      accounts.createAccount({ name: 'Dup', configDir: '/home/user/.claude' });
      expect(() => {
        accounts.createAccount({ name: 'Dup', configDir: '/home/user/.claude-2' });
      }).toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Path rules
  // -----------------------------------------------------------------------

  describe('path rules', () => {
    it('adds and lists path rules', () => {
      const work = accounts.createAccount({ name: 'Work', configDir: '/home/user/.claude-work', subscriptionLabel: 'team' });

      accounts.addPathRule(work.id, '/home/user/work', 10);

      const rules = accounts.listPathRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].path_prefix).toBe('/home/user/work');
      expect(rules[0].account_name).toBe('Work');
      expect(rules[0].account_engine).toBe('claude');
      expect(rules[0].priority).toBe(10);
    });

    it('removes a path rule', () => {
      const work = accounts.createAccount({ name: 'Work', configDir: '/home/user/.claude-work' });
      accounts.addPathRule(work.id, '/home/user/work');

      const [rule] = accounts.listPathRules();
      accounts.removePathRule(rule.id);

      expect(accounts.listPathRules()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Resolution — ResolvePair
  // -----------------------------------------------------------------------

  describe('resolution', () => {
    it('resolves the claude slot via explicit project override', () => {
      accounts.createAccount({ name: 'Default', configDir: '/home/user/.claude' });
      const work = accounts.createAccount({ name: 'Work', configDir: '/home/user/.claude-work', subscriptionLabel: 'team' });

      accounts.setProjectOverride('/home/user/projects/myapp', work.id);

      const pair = accounts.resolve('/home/user/projects/myapp');
      expect(pair.claude?.account.id).toBe(work.id);
      expect(pair.claude?.matchType).toBe('override');
      expect(pair.codex).toBeNull();
    });

    it('resolves the claude slot via longest matching path rule', () => {
      const work = accounts.createAccount({ name: 'Work', configDir: '/home/user/.claude-work', subscriptionLabel: 'team' });
      const oss = accounts.createAccount({ name: 'OSS', configDir: '/home/user/.claude-oss' });

      accounts.addPathRule(work.id, '/home/user/work', 0);
      accounts.addPathRule(oss.id, '/home/user/work/oss', 0);

      const pair = accounts.resolve('/home/user/work/oss/myrepo');
      expect(pair.claude?.account.id).toBe(oss.id);
      expect(pair.claude?.matchType).toBe('path_rule');
    });

    it('returns both null when no override or path rule matches (no default fallback)', () => {
      accounts.createAccount({ name: 'Default', configDir: '/home/user/.claude' });
      accounts.createAccount({ name: 'Work', configDir: '/home/user/.claude-work' });

      expect(accounts.resolve('/home/user/personal/myrepo')).toEqual({ claude: null, codex: null });
    });

    it('path rule resolves the claude slot', () => {
      const work = accounts.createAccount({ name: 'Work', configDir: '/home/user/.claude-work' });
      accounts.addPathRule(work.id, '/home/user/work', 0);

      const pair = accounts.resolve('/home/user/work/myrepo');
      expect(pair.claude?.account.id).toBe(work.id);
      expect(pair.codex).toBeNull();
    });

    it('explicit override beats path rule, per engine', () => {
      const claudeRule = accounts.createAccount({ name: 'CR', configDir: '/cr' });
      const claudeOverride = accounts.createAccount({ name: 'CO', configDir: '/co' });
      const codex = accounts.createAccount({ name: 'X', configDir: '/x', engine: 'codex' });

      accounts.addPathRule(claudeRule.id, '/home/user/work', 0);
      accounts.addPathRule(codex.id, '/home/user/work', 0);
      accounts.setProjectOverride('/home/user/work/myapp', claudeOverride.id);

      const pair = accounts.resolve('/home/user/work/myapp');
      expect(pair.claude?.account.id).toBe(claudeOverride.id);
      expect(pair.claude?.matchType).toBe('override');
      expect(pair.codex?.account.id).toBe(codex.id);
      expect(pair.codex?.matchType).toBe('path_rule');
    });

    it('fills both slots when path rules exist for both engines', () => {
      const claude = accounts.createAccount({ name: 'C', configDir: '/c' });
      const codex = accounts.createAccount({ name: 'X', configDir: '/x', engine: 'codex' });
      accounts.addPathRule(claude.id, '/proj', 0);
      accounts.addPathRule(codex.id, '/proj', 0);

      const pair = accounts.resolve('/proj/sub');
      expect(pair.claude?.account.id).toBe(claude.id);
      expect(pair.codex?.account.id).toBe(codex.id);
      expect(pair.claude?.matchType).toBe('path_rule');
    });

    it('a codex path rule fills only the codex slot', () => {
      const codex = accounts.createAccount({ name: 'Codex', configDir: '/home/user/.codex', engine: 'codex' });
      accounts.addPathRule(codex.id, '/home/user/codex-work', 0);

      const pair = accounts.resolve('/home/user/codex-work/myrepo');
      expect(pair.codex?.account.id).toBe(codex.id);
      expect(pair.codex?.matchType).toBe('path_rule');
      expect(pair.claude).toBeNull();
    });

    it('longest matching prefix wins per engine', () => {
      const a = accounts.createAccount({ name: 'A', configDir: '/a' });
      const b = accounts.createAccount({ name: 'B', configDir: '/b' });
      accounts.addPathRule(a.id, '/proj', 0);
      accounts.addPathRule(b.id, '/proj/deep', 0);

      const pair = accounts.resolve('/proj/deep/sub');
      expect(pair.claude?.account.id).toBe(b.id);
    });
  });

  // -----------------------------------------------------------------------
  // Explain resolution
  // -----------------------------------------------------------------------

  describe('explain resolution', () => {
    it('explains override match', () => {
      const work = accounts.createAccount({ name: 'Work', configDir: '/home/user/.claude-work', subscriptionLabel: 'team' });

      accounts.setProjectOverride('/home/user/projects/myapp', work.id);

      const explanation = accounts.explainResolution('/home/user/projects/myapp');
      expect(explanation).not.toBeNull();
      expect(explanation!.match_type).toBe('override');
      expect(explanation!.account.id).toBe(work.id);
    });

    it('explains path rule match', () => {
      const work = accounts.createAccount({ name: 'Work', configDir: '/home/user/.claude-work' });

      accounts.addPathRule(work.id, '/home/user/work', 5);

      const explanation = accounts.explainResolution('/home/user/work/myrepo');
      expect(explanation).not.toBeNull();
      expect(explanation!.match_type).toBe('path_rule');
      expect(explanation!.match_detail).toBe('/home/user/work');
      expect(explanation!.account.id).toBe(work.id);
    });

    it('resolves the requested engine, not whichever prefix is longest', () => {
      // A Claude session on a path that ALSO matches a longer Codex rule must
      // still report the Claude account in its header — engine-agnostic
      // resolution would surface Codex here (the longer-prefix winner).
      const claude = accounts.createAccount({ name: 'Personal', configDir: '/home/user/.claude' });
      const codex = accounts.createAccount({ name: 'Codex', configDir: '/home/user/.codex', engine: 'codex' });
      accounts.addPathRule(claude.id, '/home/user/proj', 0);
      accounts.addPathRule(codex.id, '/home/user/proj/deep', 0);

      const forClaude = accounts.explainResolution('/home/user/proj/deep/sub', 'claude');
      expect(forClaude).not.toBeNull();
      expect(forClaude!.account.id).toBe(claude.id);

      const forCodex = accounts.explainResolution('/home/user/proj/deep/sub', 'codex');
      expect(forCodex).not.toBeNull();
      expect(forCodex!.account.id).toBe(codex.id);
    });

    it('returns null for an engine with no matching rule even when the other engine matches', () => {
      // Deleting/never-having a Codex account for a path must not let a Claude
      // match leak into the Codex slot (and vice versa).
      const claude = accounts.createAccount({ name: 'Personal', configDir: '/home/user/.claude' });
      accounts.addPathRule(claude.id, '/home/user/proj', 0);

      expect(accounts.explainResolution('/home/user/proj/x', 'claude')!.account.id).toBe(claude.id);
      expect(accounts.explainResolution('/home/user/proj/x', 'codex')).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Icon field
  // -----------------------------------------------------------------------

  describe('icon field', () => {
    it('persists icon on create and reads it back via listAccounts', () => {
      accounts.createAccount({ name: 'Personal', configDir: '/home/user/.claude', color: '#a78bfa', icon: 'user' });
      const list = accounts.listAccounts();
      expect(list[0].icon).toBe('user');
    });

    it('updates icon via updateAccount', () => {
      const acct = accounts.createAccount({ name: 'Work', configDir: '/home/user/.claude-work', subscriptionLabel: 'team', color: '#f59e0b', icon: 'briefcase' });
      accounts.updateAccount(acct.id, { name: 'Work', configDir: '/home/user/.claude-work', subscriptionLabel: 'team', color: '#f59e0b', icon: 'rocket' });
      const list = accounts.listAccounts();
      expect(list[0].icon).toBe('rocket');
    });

    it('icon is null when not provided on create', () => {
      accounts.createAccount({ name: 'NoIcon', configDir: '/home/user/.claude' });
      const list = accounts.listAccounts();
      expect(list[0].icon).toBeNull();
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

    it('scanForNewAccounts returns an array', async () => {
      const created = await accounts.scanForNewAccounts();
      expect(Array.isArray(created)).toBe(true);
    });

    it('scanForNewAccounts does not duplicate accounts on a second call', async () => {
      await accounts.scanForNewAccounts();
      const countAfterFirst = accounts.listAccounts().length;

      const secondPass = await accounts.scanForNewAccounts();

      expect(secondPass).toEqual([]);
      expect(accounts.listAccounts()).toHaveLength(countAfterFirst);
    });
  });

  // -----------------------------------------------------------------------
  // Per-session summary settings (toggle + model)
  // -----------------------------------------------------------------------

  describe('summary settings', () => {
    it('migration adds summarizeOnClose + summaryModel columns', () => {
      const cols = db.raw.pragma('table_info(accounts)') as { name: string }[];
      const names = cols.map((c) => c.name);
      expect(names).toContain('summarizeOnClose');
      expect(names).toContain('summaryModel');
    });

    it('defaults to summarizeOnClose=false / summaryModel=null on a fresh account', () => {
      const a = accounts.createAccount({ name: 'SumDefault', configDir: '/tmp/sum-default' });
      const reread = accounts.listAccounts().find((x) => x.id === a.id)!;
      expect(reread.summarizeOnClose).toBe(false);
      expect(reread.summaryModel).toBeNull();
    });

    it('updateSummarySettings persists toggle + model', () => {
      const a = accounts.createAccount({ name: 'SumUpdate', configDir: '/tmp/sum-update' });
      accounts.updateSummarySettings(a.id, true, 'claude-haiku-4-5');
      const reread = accounts.listAccounts().find((x) => x.id === a.id)!;
      expect(reread.summarizeOnClose).toBe(true);
      expect(reread.summaryModel).toBe('claude-haiku-4-5');
    });

    it('updateSummarySettings can clear the model and disable the toggle', () => {
      const a = accounts.createAccount({ name: 'SumClear', configDir: '/tmp/sum-clear' });
      accounts.updateSummarySettings(a.id, true, 'claude-sonnet-4-6');
      accounts.updateSummarySettings(a.id, false, null);
      const reread = accounts.listAccounts().find((x) => x.id === a.id)!;
      expect(reread.summarizeOnClose).toBe(false);
      expect(reread.summaryModel).toBeNull();
    });
  });
});
