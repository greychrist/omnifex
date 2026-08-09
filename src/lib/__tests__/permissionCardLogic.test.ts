import { describe, it, expect } from 'vitest';
import {
  parseRuleString,
  formatRuleString,
  buildPersistedSuggestion,
  buildSessionSuggestion,
  getInitialRuleString,
  unmatchedFileRuleWarning,
  buildCommandPreview,
  commandPreviewWarning,
  canonicalizeRule,
  firstRuleSuggestion,
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

describe('unmatchedFileRuleWarning', () => {
  // CLI ≥2.1.210: file permission checks match only Edit(path) and
  // Read(path). Write(path)/NotebookEdit(path)/Glob(path) rules are accepted
  // but never matched, and the CLI warns for each at startup. Mirror that
  // warning at authoring time so the rule never gets saved in a dead form.
  it('warns on Write(path) and suggests Edit', () => {
    expect(unmatchedFileRuleWarning('Write(docs/**)')).toContain('Edit(docs/**)');
  });

  it('warns on NotebookEdit(path) and suggests Edit', () => {
    expect(unmatchedFileRuleWarning('NotebookEdit(notebooks/**)')).toContain(
      'Edit(notebooks/**)',
    );
  });

  it('warns on Glob(path) and suggests Read', () => {
    expect(unmatchedFileRuleWarning('Glob(src/**)')).toContain('Read(src/**)');
  });

  it('does not warn on bare tool-name rules (they match the tool everywhere)', () => {
    expect(unmatchedFileRuleWarning('Write')).toBeNull();
    expect(unmatchedFileRuleWarning('Glob')).toBeNull();
  });

  it('does not warn on matched forms or other tools', () => {
    expect(unmatchedFileRuleWarning('Edit(docs/**)')).toBeNull();
    expect(unmatchedFileRuleWarning('Read(src/**)')).toBeNull();
    expect(unmatchedFileRuleWarning('Bash(git:*)')).toBeNull();
    expect(unmatchedFileRuleWarning('WebFetch(domain:example.com)')).toBeNull();
    expect(unmatchedFileRuleWarning('')).toBeNull();
  });
});

describe('buildCommandPreview', () => {
  it('passes ordinary commands through untouched', () => {
    const p = buildCommandPreview('git status --porcelain');
    expect(p.text).toBe('git status --porcelain');
    expect(p.hiddenCount).toBe(0);
    expect(p.lineCount).toBe(1);
  });

  it('makes zero-width characters visible instead of dropping them', () => {
    // U+200B between `rm` and the rest renders as nothing in a <pre>, so the
    // approval dialog would show a command different from the one that runs.
    const p = buildCommandPreview('rm\u200B -rf ~/data');
    expect(p.text).toBe('rm<U+200B> -rf ~/data');
    expect(p.hiddenCount).toBe(1);
  });

  it('makes bidi override characters visible', () => {
    // RLO can visually reverse the tail of a command in the dialog.
    const p = buildCommandPreview('echo safe\u202E dangerous');
    expect(p.text).toBe('echo safe<U+202E> dangerous');
    expect(p.hiddenCount).toBe(1);
  });

  it('visualizes tabs so padding cannot be mistaken for absent text', () => {
    const p = buildCommandPreview('ls\t\t\t; rm -rf /');
    expect(p.text).toBe('ls⇥⇥⇥; rm -rf /');
    expect(p.hiddenCount).toBe(3);
  });

  it('counts every neutralized character across the whole string', () => {
    const p = buildCommandPreview('a\u200Bb\uFEFFc\u00ADd');
    expect(p.hiddenCount).toBe(3);
    expect(p.text).toBe('a<U+200B>b<U+FEFF>c<U+00AD>d');
  });

  it('preserves newlines and reports the line count', () => {
    const p = buildCommandPreview('one\ntwo\nthree');
    expect(p.text).toBe('one\ntwo\nthree');
    expect(p.lineCount).toBe(3);
    expect(p.hiddenCount).toBe(0);
  });

  it('neutralizes line/paragraph separators that break rendering', () => {
    const p = buildCommandPreview('echo a\u2028rm -rf /');
    expect(p.text).toBe('echo a<U+2028>rm -rf /');
    expect(p.hiddenCount).toBe(1);
    expect(p.lineCount).toBe(1);
  });

  it('handles empty input without throwing', () => {
    const p = buildCommandPreview('');
    expect(p.text).toBe('');
    expect(p.hiddenCount).toBe(0);
    expect(p.lineCount).toBe(1);
  });
});

describe('commandPreviewWarning', () => {
  it('is null for a short, clean command', () => {
    expect(commandPreviewWarning(buildCommandPreview('ls -la'))).toBeNull();
  });

  it('warns when hidden characters were found', () => {
    const w = commandPreviewWarning(buildCommandPreview('rm\u200B -rf ~'));
    expect(w).toContain('1 hidden character');
  });

  it('pluralizes the hidden-character warning', () => {
    const w = commandPreviewWarning(buildCommandPreview('a\u200Bb\u200Cc'));
    expect(w).toContain('2 hidden characters');
  });

  it('warns when the command is long enough to scroll out of view', () => {
    const w = commandPreviewWarning(buildCommandPreview('x\n'.repeat(40)));
    expect(w).toContain('41 lines');
  });

  it('reports both problems together', () => {
    const w = commandPreviewWarning(buildCommandPreview('a\u200B\n' + 'x\n'.repeat(40)));
    expect(w).toContain('hidden character');
    expect(w).toContain('lines');
  });
});

describe('canonicalizeRule', () => {
  it.each(['Write', 'MultiEdit', 'NotebookEdit'])(
    'rewrites %s(path) to Edit(path) — only Edit rules are matched by file permission checks',
    (toolName) => {
      expect(canonicalizeRule({ toolName, ruleContent: '/src/foo.ts' })).toEqual({
        toolName: 'Edit',
        ruleContent: '/src/foo.ts',
      });
    },
  );

  it('leaves the path untouched when rewriting the tool name', () => {
    expect(
      canonicalizeRule({ toolName: 'Write', ruleContent: '~/Library/CloudStorage/OneDrive/**' }),
    ).toEqual({ toolName: 'Edit', ruleContent: '~/Library/CloudStorage/OneDrive/**' });
  });

  it.each(['Edit', 'Read', 'Bash', 'WebFetch'])('leaves %s alone', (toolName) => {
    const rule = { toolName, ruleContent: 'whatever' };
    expect(canonicalizeRule(rule)).toEqual(rule);
  });

  it('leaves bare tool-name rules alone — those match at the tool level', () => {
    expect(canonicalizeRule({ toolName: 'Write' })).toEqual({ toolName: 'Write' });
  });

  it('leaves Bash-style ":*" content alone — that is not a path rule', () => {
    const rule = { toolName: 'Write', ruleContent: 'npm:*' };
    expect(canonicalizeRule(rule)).toEqual(rule);
  });

  it('leaves Glob alone — Glob content is a pattern, not a path, and --allowedTools honors it', () => {
    const rule = { toolName: 'Glob', ruleContent: '**/*.ts' };
    expect(canonicalizeRule(rule)).toEqual(rule);
  });

  it('does not mutate its input', () => {
    const rule = { toolName: 'Write', ruleContent: '/a.ts' };
    canonicalizeRule(rule);
    expect(rule).toEqual({ toolName: 'Write', ruleContent: '/a.ts' });
  });
});

describe('buildPersistedSuggestion — canonicalisation at the persistence boundary', () => {
  it('persists Write(path) as Edit(path)', () => {
    const out = buildPersistedSuggestion('Write(/src/foo.ts)', 'localSettings');
    expect(out.rules).toEqual([{ toolName: 'Edit', ruleContent: '/src/foo.ts' }]);
  });

  it('still persists a bare Write rule as-is', () => {
    const out = buildPersistedSuggestion('Write', 'localSettings');
    expect(out.rules).toEqual([{ toolName: 'Write' }]);
  });
});

describe('getInitialRuleString — shows the rule that will actually be written', () => {
  it('renders a CLI-suggested Write(path) as Edit(path)', () => {
    const suggestion = {
      type: 'addRules',
      rules: [{ toolName: 'Write', ruleContent: '/src/foo.ts' }],
      behavior: 'allow',
      destination: 'localSettings',
    };
    expect(getInitialRuleString(suggestion as never, 'Write')).toBe('Edit(/src/foo.ts)');
  });
});

describe('unmatchedFileRuleWarning', () => {
  it('covers MultiEdit too', () => {
    expect(unmatchedFileRuleWarning('MultiEdit(/src/foo.ts)')).toContain('Edit(/src/foo.ts)');
  });
});

describe('firstRuleSuggestion', () => {
  const setMode = { type: 'setMode', mode: 'acceptEdits', destination: 'session' };
  const addRules = {
    type: 'addRules',
    rules: [{ toolName: 'Edit', ruleContent: '/a.ts' }],
    behavior: 'allow',
    destination: 'localSettings',
  };

  it('picks the addRules entry even when it is not first', () => {
    expect(firstRuleSuggestion([setMode, addRules] as never)).toBe(addRules);
  });

  it('returns undefined when no entry carries usable rules', () => {
    expect(firstRuleSuggestion([setMode] as never)).toBeUndefined();
  });

  it('skips an addRules entry with an empty rules array', () => {
    const empty = { type: 'addRules', rules: [], behavior: 'allow', destination: 'localSettings' };
    expect(firstRuleSuggestion([empty, addRules] as never)).toBe(addRules);
  });

  it('returns undefined for empty or missing input', () => {
    expect(firstRuleSuggestion([])).toBeUndefined();
    expect(firstRuleSuggestion(undefined)).toBeUndefined();
  });
});
