import { describe, it, expect } from 'vitest';
import { describeRule, diffLiveRules, FILE_RULE_SOURCES } from '@/lib/livePermissionRules';
import type { CliPermissionRule, CliPermissionRulesState } from '@/lib/api';

const rule = (p: Partial<CliPermissionRule>): CliPermissionRule => ({
  behavior: 'allow',
  source: 'userSettings',
  rule: 'Bash(npm run test:*)',
  editability: 'persistent',
  ...p,
});

const state = (rules: CliPermissionRule[], extra: Partial<CliPermissionRulesState> = {}) => ({
  rules,
  workspaceDirectories: [],
  originalCwd: '/proj',
  managedOnly: false,
  ...extra,
});

describe('diffLiveRules — what the settings-file panel cannot show', () => {
  // permissions-io.ts reads `permissions.allow` and `permissions.deny` only.
  // An `ask` rule sitting in the very same file is invisible to the panel,
  // and "Add Rule" cannot create one (behavior is typed 'allow' | 'deny').
  it('flags an ask rule even when it lives in a settings file', () => {
    const ask = rule({ behavior: 'ask', source: 'projectSettings' });
    expect(diffLiveRules(state([ask])).hidden).toEqual([ask]);
  });

  // The panel models three sources. Everything else — policy, --allowedTools,
  // slash-command grants, session approvals — is structurally unreachable.
  it('flags rules from every non-file source', () => {
    const rules = [
      rule({ source: 'policySettings', behavior: 'deny' }),
      rule({ source: 'cliArg' }),
      rule({ source: 'session' }),
      rule({ source: 'mcpServerPolicy' }),
    ];
    expect(diffLiveRules(state(rules)).hidden).toEqual(rules);
  });

  // flagSettings is where OmniFex's OWN applyPermissions push lands. Showing
  // it would be showing the user their own echo, so it is deliberately not a
  // gap — but it is also not a file source, so this pins the intent.
  it('does not flag flagSettings, which is our own rule push echoed back', () => {
    expect(diffLiveRules(state([rule({ source: 'flagSettings' })])).hidden).toEqual([]);
  });

  it('does not flag an ordinary allow/deny rule from a settings file', () => {
    const rules = FILE_RULE_SOURCES.flatMap((source) => [
      rule({ source, behavior: 'allow' }),
      rule({ source, behavior: 'deny' }),
    ]);
    expect(diffLiveRules(state(rules)).hidden).toEqual([]);
  });

  // The inverse failure: the panel shows a rule from a settings file that the
  // session is ignoring, so the user reads it as active when it is not.
  it('separates rules the session is ignoring under managed policy', () => {
    const dead = rule({ notInEffect: true, source: 'projectSettings' });
    const live = rule({ source: 'userSettings' });
    const got = diffLiveRules(state([dead, live], { managedOnly: true }));
    expect(got.ignored).toEqual([dead]);
    expect(got.managedOnly).toBe(true);
    // An ignored rule is reported once, as ignored — not also as hidden.
    expect(got.hidden).toEqual([]);
  });

  it('reports nothing for a null state so the caller keeps the file view', () => {
    expect(diffLiveRules(null)).toEqual({ hidden: [], ignored: [], managedOnly: false });
  });
});

describe('describeRule', () => {
  // The CLI splits its plain-language reading into fixed words plus the rule
  // content, so hosts can bold the content fragment the way the terminal does.
  it('joins the CLI description parts in order', () => {
    const r = rule({ description: { prefix: 'Any Bash command starting with', emphasis: 'npm run' } });
    expect(describeRule(r)).toBe('Any Bash command starting with npm run');
  });

  it('includes a suffix when present', () => {
    const r = rule({ description: { prefix: 'Edits to', emphasis: '/src/**', suffix: 'in this project' } });
    expect(describeRule(r)).toBe('Edits to /src/** in this project');
  });

  // Absent where the terminal shows no subtitle either — fall back to the
  // verbatim rule rather than rendering an empty line.
  it('falls back to the verbatim rule when the CLI gives no description', () => {
    expect(describeRule(rule({ rule: 'Bash(git status:*)' }))).toBe('Bash(git status:*)');
  });
});
