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
      accounts.createAccount('Personal', '/home/user/.claude', 'pro');
      accounts.createAccount('Work', '/home/user/.claude-work', 'team');

      const list = accounts.listAccounts();
      expect(list).toHaveLength(2);
      expect(list.map((a) => a.name)).toContain('Personal');
      expect(list.map((a) => a.name)).toContain('Work');
    });

    it('updates an account', () => {
      accounts.createAccount('Personal', '/home/user/.claude', 'pro');
      const [acct] = accounts.listAccounts();

      accounts.updateAccount(acct.id, 'Personal Updated', '/home/user/.claude-new', 'team');

      const updated = accounts.listAccounts().find((a) => a.id === acct.id)!;
      expect(updated.name).toBe('Personal Updated');
      expect(updated.config_dir).toBe('/home/user/.claude-new');
      expect(updated.account_type).toBe('team');
    });

    it('round-trips cli_path through createAccount', () => {
      accounts.createAccount('Personal', '/home/user/.claude', 'max', undefined, undefined, undefined, '/Users/g/.local/bin/claude');
      const [acct] = accounts.listAccounts();
      expect(acct.cli_path).toBe('/Users/g/.local/bin/claude');
    });

    it('round-trips cli_path through updateAccount', () => {
      accounts.createAccount('Personal', '/home/user/.claude', 'max', undefined, undefined, undefined, '/initial/claude');
      const [acct] = accounts.listAccounts();
      accounts.updateAccount(acct.id, 'Personal', '/home/user/.claude', 'max', undefined, undefined, undefined, '/updated/claude');
      const after = accounts.listAccounts().find((a) => a.id === acct.id)!;
      expect(after.cli_path).toBe('/updated/claude');
    });

    it('clears cli_path when updateAccount is called with null', () => {
      accounts.createAccount('Personal', '/home/user/.claude', 'max', undefined, undefined, undefined, '/initial/claude');
      const [acct] = accounts.listAccounts();
      accounts.updateAccount(acct.id, 'Personal', '/home/user/.claude', 'max', undefined, undefined, undefined, null);
      const after = accounts.listAccounts().find((a) => a.id === acct.id)!;
      expect(after.cli_path).toBeNull();
    });

    it('defaults cli_path to null on createAccount when not provided', () => {
      accounts.createAccount('Work', '/home/user/.claude-work');
      const [acct] = accounts.listAccounts();
      expect(acct.cli_path).toBeNull();
    });

    it('stores and returns session_defaults on create', () => {
      accounts.createAccount('Personal', '/home/user/.claude', 'pro', undefined, undefined, {
        model: 'sonnet',
        thinkingConfig: 'disabled',
        permissionMode: 'acceptEdits',
      });
      const [acct] = accounts.listAccounts();
      expect(acct.session_defaults).toEqual({
        model: 'sonnet',
        thinkingConfig: 'disabled',
        permissionMode: 'acceptEdits',
      });
    });

    it('stores and returns session_defaults on update', () => {
      accounts.createAccount('Personal', '/home/user/.claude', 'pro');
      const [acct] = accounts.listAccounts();

      accounts.updateAccount(acct.id, 'Personal', '/home/user/.claude', 'pro', undefined, undefined, {
        model: 'opus[1m]',
        thinkingConfig: 'adaptive',
        permissionMode: 'default',
      });

      const updated = accounts.listAccounts().find((a) => a.id === acct.id)!;
      expect(updated.session_defaults).toEqual({
        model: 'opus[1m]',
        thinkingConfig: 'adaptive',
        permissionMode: 'default',
      });
    });

    it('preserves existing session_defaults when update omits them', () => {
      accounts.createAccount('Personal', '/home/user/.claude', 'pro', undefined, undefined, {
        model: 'sonnet',
      });
      const [acct] = accounts.listAccounts();

      accounts.updateAccount(acct.id, 'Personal Renamed', '/home/user/.claude');

      const updated = accounts.listAccounts().find((a) => a.id === acct.id)!;
      expect(updated.session_defaults).toEqual({ model: 'sonnet' });
    });

    it("normalizes a legacy 'budget' thinkingConfig in stored session_defaults to 'adaptive' on read", () => {
      // Schema migration in v0.4.21 collapsed thinkingConfig to a
      // two-state ('adaptive' | 'disabled') value. Accounts saved
      // before that migration may still carry the legacy 'budget'
      // entry in session_defaults JSON. The deserializer should coerce
      // it to 'adaptive' silently — that's what the SDK already
      // collapsed any non-zero budget to at runtime, so behavior is
      // unchanged; only the stored label is lying.
      accounts.createAccount('Legacy', '/home/user/.claude', 'pro');
      const [acct] = accounts.listAccounts();
      // Drop a legacy payload directly into the row, bypassing the
      // typed API which no longer accepts 'budget'.
      const legacyJson = JSON.stringify({
        model: 'sonnet',
        thinkingConfig: 'budget',
        permissionMode: 'default',
      });
      db.raw.prepare('UPDATE accounts SET session_defaults = ? WHERE id = ?').run(legacyJson, acct.id);

      const reloaded = accounts.listAccounts().find((a) => a.id === acct.id)!;
      expect(reloaded.session_defaults).toEqual({
        model: 'sonnet',
        thinkingConfig: 'adaptive',
        permissionMode: 'default',
      });
    });

    it("strips an unknown thinkingConfig value rather than passing it through", () => {
      // Defensive: any future schema drift (or hand-edited DB) that
      // produces a value outside the two known states should be
      // dropped, not propagated to the renderer where it would render
      // as a no-op picker state.
      accounts.createAccount('Garbage', '/home/user/.claude', 'pro');
      const [acct] = accounts.listAccounts();
      const garbageJson = JSON.stringify({ thinkingConfig: 'totally-unknown' });
      db.raw.prepare('UPDATE accounts SET session_defaults = ? WHERE id = ?').run(garbageJson, acct.id);

      const reloaded = accounts.listAccounts().find((a) => a.id === acct.id)!;
      expect(reloaded.session_defaults?.thinkingConfig).toBeUndefined();
    });

    it('clears session_defaults when explicitly set to null', () => {
      accounts.createAccount('Personal', '/home/user/.claude', 'pro', undefined, undefined, {
        model: 'sonnet',
      });
      const [acct] = accounts.listAccounts();

      accounts.updateAccount(acct.id, 'Personal', '/home/user/.claude', undefined, undefined, undefined, null);

      const updated = accounts.listAccounts().find((a) => a.id === acct.id)!;
      expect(updated.session_defaults).toBeUndefined();
    });

    it('deletes an account', () => {
      accounts.createAccount('ToDelete', '/home/user/.claude', 'pro');
      const [acct] = accounts.listAccounts();

      accounts.deleteAccount(acct.id);

      expect(accounts.listAccounts()).toHaveLength(0);
    });

    it('enforces unique name constraint', () => {
      accounts.createAccount('Dup', '/home/user/.claude', 'pro');
      expect(() => {
        accounts.createAccount('Dup', '/home/user/.claude-2', 'pro');
      }).toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Path rules
  // -----------------------------------------------------------------------

  describe('path rules', () => {
    it('adds and lists path rules', () => {
      accounts.createAccount('Work', '/home/user/.claude-work', 'team');
      const [work] = accounts.listAccounts();

      accounts.addPathRule(work.id, '/home/user/work', 10);

      const rules = accounts.listPathRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].path_prefix).toBe('/home/user/work');
      expect(rules[0].account_name).toBe('Work');
      expect(rules[0].priority).toBe(10);
    });

    it('removes a path rule', () => {
      accounts.createAccount('Work', '/home/user/.claude-work', 'team');
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
      accounts.createAccount('Default', '/home/user/.claude', 'pro');
      accounts.createAccount('Work', '/home/user/.claude-work', 'team');
      const [_def, work] = accounts.listAccounts().sort((a, b) => a.name.localeCompare(b.name));

      accounts.setProjectOverride('/home/user/projects/myapp', work.id);

      const resolved = accounts.resolve('/home/user/projects/myapp');
      expect(resolved).not.toBeNull();
      // Project overrides are Claude-only today — the override table carries
      // no agent column, so resolution pins agent='claude'.
      expect(resolved!.agent).toBe('claude');
      expect(resolved!.account).not.toBeNull();
      expect(resolved!.account!.id).toBe(work.id);
    });

    it('resolves via longest matching path rule', () => {
      accounts.createAccount('Work', '/home/user/.claude-work', 'team');
      accounts.createAccount('OSS', '/home/user/.claude-oss', 'pro');
      const [oss, work] = accounts.listAccounts().sort((a, b) => a.name.localeCompare(b.name));

      accounts.addPathRule(work.id, '/home/user/work', 0);
      accounts.addPathRule(oss.id, '/home/user/work/oss', 0);

      const resolved = accounts.resolve('/home/user/work/oss/myrepo');
      expect(resolved).not.toBeNull();
      expect(resolved!.agent).toBe('claude');
      expect(resolved!.account).not.toBeNull();
      expect(resolved!.account!.id).toBe(oss.id);
    });

    it('returns null when no override or path rule matches (no default fallback)', () => {
      accounts.createAccount('Default', '/home/user/.claude', 'pro');
      accounts.createAccount('Work', '/home/user/.claude-work', 'team');

      const resolved = accounts.resolve('/home/user/personal/myrepo');
      expect(resolved).toBeNull();
    });

    it('returns null when nothing matches', () => {
      accounts.createAccount('Work', '/home/user/.claude-work', 'team');
      // no default, no rules

      const resolved = accounts.resolve('/home/user/personal/myrepo');
      expect(resolved).toBeNull();
    });

    it('path rule beats default account', () => {
      accounts.createAccount('Default', '/home/user/.claude', 'pro');
      accounts.createAccount('Work', '/home/user/.claude-work', 'team');
      const [_def, work] = accounts.listAccounts().sort((a, b) => a.name.localeCompare(b.name));

      accounts.addPathRule(work.id, '/home/user/work', 0);

      const resolved = accounts.resolve('/home/user/work/myrepo');
      expect(resolved).not.toBeNull();
      expect(resolved!.agent).toBe('claude');
      expect(resolved!.account).not.toBeNull();
      expect(resolved!.account!.id).toBe(work.id);
    });

    it('explicit override beats path rule', () => {
      accounts.createAccount('Work', '/home/user/.claude-work', 'team');
      accounts.createAccount('Special', '/home/user/.claude-special', 'pro');
      const [special, work] = accounts.listAccounts().sort((a, b) => a.name.localeCompare(b.name));

      accounts.addPathRule(work.id, '/home/user/work', 0);
      accounts.setProjectOverride('/home/user/work/myapp', special.id);

      const resolved = accounts.resolve('/home/user/work/myapp');
      expect(resolved).not.toBeNull();
      expect(resolved!.agent).toBe('claude');
      expect(resolved!.account).not.toBeNull();
      expect(resolved!.account!.id).toBe(special.id);
    });

    // -----------------------------------------------------------------------
    // Agent-aware routing (Phase 3 entry point)
    // -----------------------------------------------------------------------

    it('a claude path rule resolves to { agent: "claude", account: <the claude account> }', () => {
      accounts.createAccount('Work', '/home/user/.claude-work', 'team');
      const [work] = accounts.listAccounts();

      accounts.addPathRule(work.id, '/home/user/work', 0);

      const resolved = accounts.resolve('/home/user/work/myrepo');
      expect(resolved).not.toBeNull();
      expect(resolved!.agent).toBe('claude');
      expect(resolved!.account).not.toBeNull();
      expect(resolved!.account!.id).toBe(work.id);
    });

    it('a codex path rule (no associated claude account) resolves to { agent: "codex", account: null }', () => {
      // Codex rules carry no Claude account. addPathRule() is still
      // Claude-only this task; insert the row directly to exercise the
      // resolver's agent branch.
      db.raw
        .prepare(
          "INSERT INTO account_path_rules (account_id, path_prefix, priority, agent) VALUES (NULL, ?, ?, 'codex')"
        )
        .run('/home/user/codex-work', 0);

      const resolved = accounts.resolve('/home/user/codex-work/myrepo');
      expect(resolved).not.toBeNull();
      expect(resolved!.agent).toBe('codex');
      expect(resolved!.account).toBeNull();
    });

    it('no rule match returns null at the top level (NOT { agent: null })', () => {
      accounts.createAccount('Work', '/home/user/.claude-work', 'team');

      const resolved = accounts.resolve('/totally/unrelated/path');
      expect(resolved).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Explain resolution
  // -----------------------------------------------------------------------

  describe('explain resolution', () => {
    it('explains override match', () => {
      accounts.createAccount('Work', '/home/user/.claude-work', 'team');
      const [work] = accounts.listAccounts();

      accounts.setProjectOverride('/home/user/projects/myapp', work.id);

      const explanation = accounts.explainResolution('/home/user/projects/myapp');
      expect(explanation).not.toBeNull();
      expect(explanation!.match_type).toBe('override');
      expect(explanation!.account.id).toBe(work.id);
    });

    it('explains path rule match', () => {
      accounts.createAccount('Work', '/home/user/.claude-work', 'team');
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
  // Icon field
  // -----------------------------------------------------------------------

  describe('icon field', () => {
    it('persists icon on create and reads it back via listAccounts', () => {
      accounts.createAccount('Personal', '/home/user/.claude', 'pro', '#a78bfa', 'user');
      const list = accounts.listAccounts();
      expect(list[0].icon).toBe('user');
    });

    it('updates icon via updateAccount', () => {
      const acct = accounts.createAccount('Work', '/home/user/.claude-work', 'team', '#f59e0b', 'briefcase');
      accounts.updateAccount(acct.id, 'Work', '/home/user/.claude-work', 'team', '#f59e0b', 'rocket');
      const list = accounts.listAccounts();
      expect(list[0].icon).toBe('rocket');
    });

    it('icon is null when not provided on create', () => {
      accounts.createAccount('NoIcon', '/home/user/.claude', 'pro');
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
      const a = accounts.createAccount('SumDefault', '/tmp/sum-default');
      const reread = accounts.listAccounts().find((x) => x.id === a.id)!;
      expect(reread.summarizeOnClose).toBe(false);
      expect(reread.summaryModel).toBeNull();
    });

    it('updateSummarySettings persists toggle + model', () => {
      const a = accounts.createAccount('SumUpdate', '/tmp/sum-update');
      accounts.updateSummarySettings(a.id, true, 'claude-haiku-4-5');
      const reread = accounts.listAccounts().find((x) => x.id === a.id)!;
      expect(reread.summarizeOnClose).toBe(true);
      expect(reread.summaryModel).toBe('claude-haiku-4-5');
    });

    it('updateSummarySettings can clear the model and disable the toggle', () => {
      const a = accounts.createAccount('SumClear', '/tmp/sum-clear');
      accounts.updateSummarySettings(a.id, true, 'claude-sonnet-4-6');
      accounts.updateSummarySettings(a.id, false, null);
      const reread = accounts.listAccounts().find((x) => x.id === a.id)!;
      expect(reread.summarizeOnClose).toBe(false);
      expect(reread.summaryModel).toBeNull();
    });
  });
});
