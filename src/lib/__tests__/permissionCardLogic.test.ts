import { describe, it, expect } from 'vitest';
import {
  parseRuleString,
  formatRuleString,
  buildPersistedSuggestion,
  buildSessionSuggestion,
  getInitialRuleString,
  SCOPE_OPTIONS,
  DEFAULT_SCOPE,
} from '../permissionCardLogic';

describe('parseRuleString', () => {
  it('parses ToolName(content) into its parts', () => {
    expect(parseRuleString('Bash(git:*)')).toEqual({ toolName: 'Bash', ruleContent: 'git:*' });
  });

  it('parses bare tool name without parens', () => {
    expect(parseRuleString('Read')).toEqual({ toolName: 'Read' });
  });

  it('trims whitespace around bare tool names', () => {
    expect(parseRuleString('  Edit  ')).toEqual({ toolName: 'Edit' });
  });

  it('handles path-style rule content with slashes and stars', () => {
    expect(parseRuleString('Edit(/src/**/*.ts)')).toEqual({
      toolName: 'Edit',
      ruleContent: '/src/**/*.ts',
    });
  });

  it('handles double-slash absolute paths', () => {
    expect(parseRuleString('Write(//tmp/foo.txt)')).toEqual({
      toolName: 'Write',
      ruleContent: '//tmp/foo.txt',
    });
  });

  it('falls back to bare tool name when parens are malformed', () => {
    expect(parseRuleString('Bash(no-close-paren')).toEqual({ toolName: 'Bash(no-close-paren' });
  });
});

describe('formatRuleString', () => {
  it('renders ToolName(content) when ruleContent is set', () => {
    expect(formatRuleString({ toolName: 'Bash', ruleContent: 'git:*' })).toBe('Bash(git:*)');
  });

  it('renders bare tool name when ruleContent is undefined', () => {
    expect(formatRuleString({ toolName: 'Read' })).toBe('Read');
  });
});

describe('buildPersistedSuggestion', () => {
  it('builds an addRules suggestion with the selected destination', () => {
    expect(buildPersistedSuggestion('Bash(git:*)', 'localSettings')).toEqual({
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'git:*' }],
      behavior: 'allow',
      destination: 'localSettings',
    });
  });

  it('respects userSettings scope', () => {
    const s = buildPersistedSuggestion('Read', 'userSettings');
    expect(s.destination).toBe('userSettings');
    expect(s.rules).toEqual([{ toolName: 'Read', ruleContent: undefined }]);
  });

  it('respects projectSettings (team) scope', () => {
    const s = buildPersistedSuggestion('Edit(/src/**)', 'projectSettings');
    expect(s.destination).toBe('projectSettings');
    expect(s.rules[0]).toEqual({ toolName: 'Edit', ruleContent: '/src/**' });
  });
});

describe('buildSessionSuggestion', () => {
  it('builds an addRules suggestion that applies only to the running session', () => {
    expect(buildSessionSuggestion('Edit(/src/**)')).toEqual({
      type: 'addRules',
      rules: [{ toolName: 'Edit', ruleContent: '/src/**' }],
      behavior: 'allow',
      destination: 'session',
    });
  });

  it('throws when given an empty rule', () => {
    expect(() => buildSessionSuggestion('')).toThrow(/empty/i);
  });

  it('throws when given a whitespace-only rule', () => {
    expect(() => buildSessionSuggestion('   \t  ')).toThrow(/empty/i);
  });
});

describe('buildPersistedSuggestion validation', () => {
  it('throws when given an empty rule', () => {
    expect(() => buildPersistedSuggestion('', 'localSettings')).toThrow(/empty/i);
  });

  it('throws when given a whitespace-only rule', () => {
    expect(() => buildPersistedSuggestion('   ', 'userSettings')).toThrow(/empty/i);
  });
});

describe('getInitialRuleString', () => {
  it('returns ToolName(content) from the first suggestion rule', () => {
    expect(
      getInitialRuleString(
        { rules: [{ toolName: 'Bash', ruleContent: 'npm:*' }] },
        'Bash',
      ),
    ).toBe('Bash(npm:*)');
  });

  it('returns bare tool name when ruleContent is missing', () => {
    expect(
      getInitialRuleString({ rules: [{ toolName: 'Read' }] }, 'Read'),
    ).toBe('Read');
  });

  it('falls back to fallbackToolName when suggestion is empty', () => {
    expect(getInitialRuleString(undefined, 'WebFetch')).toBe('WebFetch');
  });

  it('falls back to fallbackToolName when suggestion.rules is empty', () => {
    expect(getInitialRuleString({ rules: [] }, 'WebFetch')).toBe('WebFetch');
  });

  it('trims the fallback tool name', () => {
    expect(getInitialRuleString(undefined, '  Edit  ')).toBe('Edit');
  });
});

describe('SCOPE_OPTIONS', () => {
  it('has Me Here as the default-matching entry', () => {
    const def = SCOPE_OPTIONS.find((o) => o.value === DEFAULT_SCOPE);
    expect(def?.label).toBe('Me, Here');
  });

  it('exposes all three scopes', () => {
    expect(SCOPE_OPTIONS.map((o) => o.value)).toEqual([
      'localSettings',
      'userSettings',
      'projectSettings',
    ]);
  });

  it('each option has a non-empty description', () => {
    for (const o of SCOPE_OPTIONS) {
      expect(o.description.length).toBeGreaterThan(0);
    }
  });
});
