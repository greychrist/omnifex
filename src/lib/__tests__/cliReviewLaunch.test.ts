import { describe, it, expect } from 'vitest';
import type { Account, ResolvePair, ResolveSlot } from '@/lib/api';
import { buildCliReviewPrompt, buildCliReviewLaunch } from '@/lib/cliReviewLaunch';

const account = (overrides: Partial<Account> = {}): Account =>
  ({
    id: 1,
    name: 'personal',
    config_dir: '/Users/x/.claude-personal',
    engine: 'claude',
    subscription_label: 'Max',
    has_cost: false,
    color: '#fff',
    icon: 'star',
    ...overrides,
  }) as Account;

const slot = (acc: Account): ResolveSlot => ({
  account: acc,
  matchType: 'path_rule',
  matchDetail: '/Users/x/Repos',
});

const pair = (claude: ResolveSlot | null, codex: ResolveSlot | null = null): ResolvePair => ({
  claude,
  codex,
});

describe('buildCliReviewPrompt', () => {
  it('carries the whole procedure, not a slash-command invocation', () => {
    // The procedure used to live in .claude/commands/cli-changelog-review.md,
    // which is gitignored — so on any machine but the author's the drift
    // warning fired a slash command the CLI had never heard of. The app now
    // ships the prompt itself.
    const prompt = buildCliReviewPrompt('2.1.222', '2.1.224');
    expect(prompt).not.toMatch(/^\/cli-changelog-review/);
    expect(prompt).toContain('src/types/jsonl.ts');
    expect(prompt.length).toBeGreaterThan(500);
  });

  it('interpolates the drifted range', () => {
    const prompt = buildCliReviewPrompt('2.1.222', '2.1.224');
    expect(prompt).toContain('2.1.222');
    expect(prompt).toContain('2.1.224');
    expect(prompt).not.toContain('{reviewedVersion}');
    expect(prompt).not.toContain('{installedVersion}');
  });

  it('honours a user-supplied template override', () => {
    expect(buildCliReviewPrompt('2.1.222', '2.1.224', 'check {installedVersion}')).toBe(
      'check 2.1.224',
    );
  });
});

describe('buildCliReviewLaunch', () => {
  const base = {
    repoDir: '/Users/x/Repos/personal/omnifex',
    reviewedVersion: '2.1.222',
    installedVersion: '2.1.224',
  };

  it('builds an auto-starting Claude chat tab carrying the review prompt', () => {
    const result = buildCliReviewLaunch({ ...base, pair: pair(slot(account())) });
    expect(result.tab).toMatchObject({
      type: 'chat',
      agent: 'claude',
      initialProjectPath: '/Users/x/Repos/personal/omnifex',
      accountName: 'personal',
    });
    expect(result.tab.initialPrompt).toContain('2.1.222');
    expect(result.tab.initialPrompt).toContain('2.1.224');
    expect(result.tab.initialSessionConfig?.sessionStartMode).toBe('rich');
  });

  it('titles the tab for the job, not the folder', () => {
    // Distinguishes it from an ordinary "omnifex" session tab at a glance.
    expect(buildCliReviewLaunch({ ...base, pair: pair(slot(account())) }).tab.title).toBe(
      'CLI 2.1.224 review',
    );
  });

  it("seeds the session from the resolved account's defaults", () => {
    const acc = account({
      session_defaults: { model: 'sonnet', effort: 'max', permissionMode: 'plan', thinkingConfig: 'disabled' },
    });
    const cfg = buildCliReviewLaunch({ ...base, pair: pair(slot(acc)) }).tab.initialSessionConfig;
    expect(cfg).toMatchObject({
      model: 'sonnet',
      effort: 'max',
      permissionMode: 'plan',
      thinkingConfig: 'disabled',
    });
  });

  it('falls back to the app defaults when the account has none', () => {
    const cfg = buildCliReviewLaunch({ ...base, pair: pair(slot(account())) }).tab.initialSessionConfig;
    expect(cfg).toMatchObject({ model: 'opus', effort: 'high', permissionMode: 'acceptEdits' });
  });

  it('bakes the resolution in so the session spawns under the resolved account', () => {
    const cfg = buildCliReviewLaunch({ ...base, pair: pair(slot(account({ name: 'work' }))) })
      .tab.initialSessionConfig;
    expect(cfg?.accountResolution?.account.name).toBe('work');
  });

  it('refuses to auto-start when no Claude account routes the repo', () => {
    // Silent accountless launches are exactly what the multi-account rules
    // forbid; hand back a tab that shows the normal routing guidance instead.
    const result = buildCliReviewLaunch({ ...base, pair: pair(null, slot(account({ engine: 'codex' }))) });
    expect(result.hasAccount).toBe(false);
    expect(result.tab.initialSessionConfig).toBeUndefined();
    expect(result.tab.initialPrompt).toBeUndefined();
    expect(result.tab.initialProjectPath).toBe('/Users/x/Repos/personal/omnifex');
  });

  it('never routes the review to a Codex account', () => {
    // The changelog under review is Claude Code's.
    const result = buildCliReviewLaunch({
      ...base,
      pair: pair(slot(account({ name: 'personal' })), slot(account({ name: 'codex-acct', engine: 'codex' }))),
    });
    expect(result.tab.agent).toBe('claude');
    expect(result.tab.accountName).toBe('personal');
  });
});

describe('buildCliReviewLaunch — prompt template', () => {
  const base = {
    repoDir: '/Users/x/Repos/personal/omnifex',
    reviewedVersion: '2.1.222',
    installedVersion: '2.1.224',
  };

  it('threads a custom template into the tab prompt', () => {
    const { tab } = buildCliReviewLaunch({
      ...base,
      pair: pair(slot(account())),
      promptTemplate: 'review {reviewedVersion}..{installedVersion}',
    });
    expect(tab.initialPrompt).toBe('review 2.1.222..2.1.224');
  });

  it('falls back to the shipped default when no template is stored', () => {
    const { tab } = buildCliReviewLaunch({ ...base, pair: pair(slot(account())) });
    expect(tab.initialPrompt).toContain('src/types/jsonl.ts');
    expect(tab.initialPrompt).toContain('2.1.224');
  });
});
