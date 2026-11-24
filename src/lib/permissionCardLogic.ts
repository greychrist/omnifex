export type PersistedScopeValue = 'localSettings' | 'userSettings' | 'projectSettings';
export type ScopeValue = PersistedScopeValue;

export interface ScopeOption {
  value: ScopeValue;
  label: string;
  description: string;
}

export const SCOPE_OPTIONS: ScopeOption[] = [
  {
    value: 'localSettings',
    label: 'Me, Here',
    description: 'This project only, not shared with the team',
  },
  {
    value: 'userSettings',
    label: 'Me, Everywhere',
    description: 'All projects on this machine',
  },
  {
    value: 'projectSettings',
    label: 'Team',
    description: 'Shared with everyone working on this repo',
  },
];

export const DEFAULT_SCOPE: ScopeValue = 'localSettings';

export interface ParsedRule {
  toolName: string;
  ruleContent?: string;
}

export interface PersistedSuggestion {
  type: 'addRules';
  rules: ParsedRule[];
  behavior: 'allow';
  destination: PersistedScopeValue;
}

export interface SessionSuggestion {
  type: 'addRules';
  rules: ParsedRule[];
  behavior: 'allow';
  destination: 'session';
}

export interface IncomingSuggestion {
  type?: string;
  rules?: ParsedRule[];
  directories?: string[];
  behavior?: string;
  destination?: string;
}

export function parseRuleString(rule: string): ParsedRule {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\((.+)\)$/.exec(rule);
  if (match) return { toolName: match[1], ruleContent: match[2] };
  return { toolName: rule.trim() };
}

export function formatRuleString(parsed: ParsedRule): string {
  return parsed.ruleContent ? `${parsed.toolName}(${parsed.ruleContent})` : parsed.toolName;
}

function assertNonEmptyRule(ruleString: string): void {
  if (!ruleString.trim()) {
    throw new Error('Cannot build permission suggestion from an empty rule');
  }
}

/** CLI 2.1.210: only `Edit(path)` and `Read(path)` rules are matched. `Glob` is absent: its content is a pattern, not a path. */
const UNMATCHED_FILE_RULE_TOOLS: Readonly<Record<string, string>> = {
  Write: 'Edit',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit',
};

/** `:*` content is Bash prefix syntax, not a path. */
export function canonicalizeRule(rule: ParsedRule): ParsedRule {
  if (!rule.ruleContent) return rule;
  if (rule.ruleContent.includes(':*')) return rule;
  const canonical = UNMATCHED_FILE_RULE_TOOLS[rule.toolName];
  return canonical ? { ...rule, toolName: canonical } : rule;
}

/** The CLI mixes `addRules` with `setMode` / `addDirectories` entries in no promised order. */
export function firstRuleSuggestion(
  suggestions: IncomingSuggestion[] | undefined,
): IncomingSuggestion | undefined {
  return suggestions?.find((s) => Array.isArray(s?.rules) && s.rules.length > 0);
}

export function buildPersistedSuggestion(
  ruleString: string,
  scope: PersistedScopeValue,
): PersistedSuggestion {
  assertNonEmptyRule(ruleString);
  const parsed = canonicalizeRule(parseRuleString(ruleString));
  return {
    type: 'addRules',
    rules: [{ toolName: parsed.toolName, ruleContent: parsed.ruleContent }],
    behavior: 'allow',
    destination: scope,
  };
}

/** The only answer that stops re-asks about a write through a symlink; the CLI persists and applies it itself (2.1.280). */
export function buildDirectoryGrant(
  directories: string[],
  destination: PersistedScopeValue | 'session',
): IncomingSuggestion {
  return { type: 'addDirectories', directories, destination };
}

export function buildSessionSuggestion(ruleString: string): SessionSuggestion {
  assertNonEmptyRule(ruleString);
  const parsed = canonicalizeRule(parseRuleString(ruleString));
  return {
    type: 'addRules',
    rules: [{ toolName: parsed.toolName, ruleContent: parsed.ruleContent }],
    behavior: 'allow',
    destination: 'session',
  };
}

export function unmatchedFileRuleWarning(ruleString: string): string | null {
  const parsed = parseRuleString(ruleString);
  if (!parsed.ruleContent) return null;
  const replacement =
    UNMATCHED_FILE_RULE_TOOLS[parsed.toolName] ??
    (parsed.toolName === 'Glob' ? 'Read' : null);
  if (!replacement) return null;
  return (
    `${parsed.toolName}(path) rules are never matched by file permission checks ` +
    `(CLI ≥2.1.210) — use ${replacement}(${parsed.ruleContent}) instead.`
  );
}

export interface CommandPreviewResult {
  text: string;
  hiddenCount: number;
  lineCount: number;
}

const INVISIBLE_RE =
  // eslint-disable-next-line no-control-regex -- matching C0/C1 control characters is this regex's purpose
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

const SCROLL_LINE_THRESHOLD = 8;

/** Under `--permission-prompt-tool stdio` this card is the only place a human sees the command; nothing is dropped, only escaped. */
export function buildCommandPreview(raw: string): CommandPreviewResult {
  let hiddenCount = 0;
  const text = raw
    .replace(/\t/g, () => {
      hiddenCount++;
      return '⇥';
    })
    .replace(INVISIBLE_RE, (ch) => {
      hiddenCount++;
      const hex = (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
      return `<U+${hex}>`;
    });
  return { text, hiddenCount, lineCount: text.split('\n').length };
}

export function commandPreviewWarning(preview: CommandPreviewResult): string | null {
  const parts: string[] = [];
  if (preview.hiddenCount > 0) {
    parts.push(
      `${preview.hiddenCount} hidden character${preview.hiddenCount === 1 ? '' : 's'} shown as escapes`,
    );
  }
  if (preview.lineCount > SCROLL_LINE_THRESHOLD) {
    parts.push(`${preview.lineCount} lines — scroll to see the whole command`);
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

export function getInitialRuleString(
  suggestion: IncomingSuggestion | undefined,
  fallbackToolName: string,
): string {
  const r = suggestion?.rules?.[0];
  if (r?.toolName) {
    // The CLI can suggest an unmatched form; show the rule that will actually be written.
    const c = canonicalizeRule(r);
    return c.ruleContent ? `${c.toolName}(${c.ruleContent})` : c.toolName;
  }
  return (fallbackToolName || '').trim();
}
