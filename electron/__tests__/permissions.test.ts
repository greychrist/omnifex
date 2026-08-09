import { describe, it, expect } from 'vitest';
import {
  augmentPermissionsWithSession,
  buildDefaultRule,
  withDefaultRuleSuggestion,
} from '../services/sessions/permissions';

describe('augmentPermissionsWithSession', () => {
  it('adds a session-destination duplicate for a localSettings allow-rule', () => {
    const input = [
      {
        type: 'addRules',
        rules: [{ toolName: 'Edit', ruleContent: '/.claude/commands/foo.md' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ];
    const out = augmentPermissionsWithSession(input as any) ?? [];
    expect(out).toHaveLength(2);
    expect(out[0].destination).toBe('localSettings');
    expect(out[1].destination).toBe('session');
    expect(out[1].rules).toEqual(input[0].rules);
    expect(out[1].behavior).toBe('allow');
    expect(out[1].type).toBe('addRules');
  });

  it('adds a session duplicate for projectSettings and userSettings entries too', () => {
    const input = [
      { type: 'addRules', rules: [{ toolName: 'Read' }], behavior: 'allow', destination: 'projectSettings' },
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'userSettings' },
    ];
    const out = augmentPermissionsWithSession(input as any) ?? [];
    expect(out).toHaveLength(4);
    expect(out.filter((u: any) => u.destination === 'session')).toHaveLength(2);
  });

  it('does not duplicate entries already targeting the session', () => {
    const input = [
      { type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'session' },
    ];
    const out = augmentPermissionsWithSession(input as any) ?? [];
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(input[0]);
  });

  it('only augments addRules — leaves setMode / addDirectories alone', () => {
    const input = [
      { type: 'setMode', mode: 'acceptEdits', destination: 'localSettings' },
      { type: 'addDirectories', directories: ['/tmp'], destination: 'projectSettings' },
      { type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'localSettings' },
    ];
    const out = augmentPermissionsWithSession(input as any) ?? [];
    // Only the addRules entry gets a session duplicate; setMode and addDirectories are passed through unchanged.
    expect(out).toHaveLength(4);
    const addRulesEntries = out.filter((u: any) => u.type === 'addRules');
    expect(addRulesEntries).toHaveLength(2);
    expect(addRulesEntries.find((u: any) => u.destination === 'session')).toBeDefined();
    expect(out.find((u: any) => u.type === 'setMode')).toBeDefined();
    expect(out.find((u: any) => u.type === 'addDirectories')).toBeDefined();
  });

  it('handles deny rules the same way (replaces in session live)', () => {
    const input = [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }], behavior: 'deny', destination: 'localSettings' },
    ];
    const out = augmentPermissionsWithSession(input as any) ?? [];
    expect(out).toHaveLength(2);
    expect(out[1].destination).toBe('session');
    expect(out[1].behavior).toBe('deny');
  });

  it('returns the input unchanged when undefined or empty', () => {
    expect(augmentPermissionsWithSession(undefined)).toBeUndefined();
    expect(augmentPermissionsWithSession([])).toEqual([]);
  });

  it('does not mutate the input array or its entries', () => {
    const input = [
      { type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'localSettings' },
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    augmentPermissionsWithSession(input as any);
    expect(input).toEqual(snapshot);
  });
});

describe('buildDefaultRule', () => {
  const PROJ = '/Users/alice/proj';

  it.each([
    ['Write', 'Edit'],
    ['MultiEdit', 'Edit'],
    ['NotebookEdit', 'Edit'],
    ['Edit', 'Edit'],
  ])('builds %s file requests as a %s(path) rule', (toolName, expected) => {
    // The CLI never suggests a rule for file-edit tools (it suggests
    // setMode:acceptEdits instead), so this is the ONLY source of the rule —
    // it has to be the form file permission checks actually match.
    expect(
      buildDefaultRule(toolName, { file_path: `${PROJ}/src/foo.ts` }, PROJ),
    ).toEqual({ toolName: expected, ruleContent: '/src/foo.ts' });
  });

  it('keeps the project-relative path form for files inside the project', () => {
    expect(buildDefaultRule('Write', { file_path: `${PROJ}/a/b.ts` }, PROJ)).toEqual({
      toolName: 'Edit',
      ruleContent: '/a/b.ts',
    });
  });

  it('uses the double-slash absolute form for files outside the project', () => {
    expect(buildDefaultRule('Write', { file_path: '/tmp/scratch.txt' }, PROJ)).toEqual({
      toolName: 'Edit',
      ruleContent: '//tmp/scratch.txt',
    });
  });

  it('falls back to a bare rule when the tool input carries no file_path', () => {
    expect(buildDefaultRule('Write', {}, PROJ)).toEqual({ toolName: 'Write' });
  });

  it('builds a Bash prefix rule from the command', () => {
    expect(buildDefaultRule('Bash', { command: 'npm run build' }, PROJ)).toEqual({
      toolName: 'Bash',
      ruleContent: 'npm:*',
    });
  });

  it('builds a WebFetch domain rule', () => {
    expect(
      buildDefaultRule('WebFetch', { url: 'https://example.com/a/b' }, PROJ),
    ).toEqual({ toolName: 'WebFetch', ruleContent: 'domain:example.com' });
  });

  it('leaves Glob rules on the Glob tool — its content is a pattern, not a path', () => {
    expect(buildDefaultRule('Glob', { pattern: '**/*.ts' }, PROJ)).toEqual({
      toolName: 'Glob',
      ruleContent: '**/*.ts',
    });
  });
});

describe('withDefaultRuleSuggestion', () => {
  const defaultRule = { toolName: 'Edit', ruleContent: '/src/foo.ts' };
  const setMode = { type: 'setMode', mode: 'acceptEdits', destination: 'session' };
  const cliRules = {
    type: 'addRules',
    rules: [{ toolName: 'Bash', ruleContent: 'npm:*' }],
    behavior: 'allow',
    destination: 'localSettings',
  };

  it('keeps the CLI setMode suggestion and adds the rule alongside it', () => {
    // A file-edit request arrives with ONLY setMode:acceptEdits. Replacing the
    // array would throw away the CLI's actual recommendation.
    const out = withDefaultRuleSuggestion([setMode] as any, defaultRule) ?? [];
    expect(out).toHaveLength(2);
    expect(out).toContainEqual(setMode);
    expect(out.some((s: any) => s.type === 'addRules')).toBe(true);
  });

  it('puts the rule suggestion first so the card reads it as the primary action', () => {
    const out = withDefaultRuleSuggestion([setMode] as any, defaultRule) ?? [];
    expect((out[0] as any).type).toBe('addRules');
    expect((out[0] as any).rules).toEqual([defaultRule]);
    expect((out[0] as any).destination).toBe('localSettings');
    expect((out[0] as any).behavior).toBe('allow');
  });

  it('leaves the CLI suggestions alone when they already carry rules', () => {
    const input = [cliRules, setMode] as any;
    expect(withDefaultRuleSuggestion(input, defaultRule)).toEqual(input);
  });

  it('adds the rule when the CLI sent an addRules entry with an empty rules array', () => {
    const empty = { type: 'addRules', rules: [], behavior: 'allow', destination: 'localSettings' };
    const out = withDefaultRuleSuggestion([empty] as any, defaultRule) ?? [];
    expect((out[0] as any).rules).toEqual([defaultRule]);
    expect(out).toHaveLength(2);
  });

  it('handles the CLI sending no suggestions at all', () => {
    const out = withDefaultRuleSuggestion(undefined, defaultRule) ?? [];
    expect(out).toHaveLength(1);
    expect((out[0] as any).rules).toEqual([defaultRule]);
  });

  it('returns the input untouched when there is no default rule to add', () => {
    expect(withDefaultRuleSuggestion([setMode] as any, null)).toEqual([setMode]);
    expect(withDefaultRuleSuggestion(undefined, null)).toBeUndefined();
  });

  it('does not mutate the input array', () => {
    const input = [setMode] as any;
    withDefaultRuleSuggestion(input, defaultRule);
    expect(input).toEqual([setMode]);
  });
});
