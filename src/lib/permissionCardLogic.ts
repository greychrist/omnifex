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
  behavior?: string;
  destination?: string;
}

/** Parse a display rule string like "Bash(git:*)" into { toolName, ruleContent }. */
export function parseRuleString(rule: string): ParsedRule {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\((.+)\)$/.exec(rule);
  if (match) return { toolName: match[1], ruleContent: match[2] };
  return { toolName: rule.trim() };
}

/** Stringify a ParsedRule back into "ToolName(content)" or bare "ToolName". */
export function formatRuleString(parsed: ParsedRule): string {
  return parsed.ruleContent ? `${parsed.toolName}(${parsed.ruleContent})` : parsed.toolName;
}

function assertNonEmptyRule(ruleString: string): void {
  if (!ruleString.trim()) {
    throw new Error('Cannot build permission suggestion from an empty rule');
  }
}

/** Build the `updatedPermissions` entry for an allow-and-persist action. */
export function buildPersistedSuggestion(
  ruleString: string,
  scope: PersistedScopeValue,
): PersistedSuggestion {
  assertNonEmptyRule(ruleString);
  const parsed = parseRuleString(ruleString);
  return {
    type: 'addRules',
    rules: [{ toolName: parsed.toolName, ruleContent: parsed.ruleContent }],
    behavior: 'allow',
    destination: scope,
  };
}

/** Build the `updatedPermissions` entry for the current CLI session only. */
export function buildSessionSuggestion(ruleString: string): SessionSuggestion {
  assertNonEmptyRule(ruleString);
  const parsed = parseRuleString(ruleString);
  return {
    type: 'addRules',
    rules: [{ toolName: parsed.toolName, ruleContent: parsed.ruleContent }],
    behavior: 'allow',
    destination: 'session',
  };
}

/**
 * Warn when a rule is in a form the CLI's file permission checks never match.
 * As of CLI 2.1.210, only `Edit(path)` and `Read(path)` rules participate in
 * file permission checks — `Write(path)`, `NotebookEdit(path)`, and
 * `Glob(path)` are accepted but dead, and the CLI logs a startup warning for
 * each. Bare tool-name rules (no path) still match the tool everywhere and
 * are fine. Returns the warning text to show inline, or null when the rule
 * is unaffected.
 */
export function unmatchedFileRuleWarning(ruleString: string): string | null {
  const parsed = parseRuleString(ruleString);
  if (!parsed.ruleContent) return null;
  const replacement =
    parsed.toolName === 'Write' || parsed.toolName === 'NotebookEdit'
      ? 'Edit'
      : parsed.toolName === 'Glob'
        ? 'Read'
        : null;
  if (!replacement) return null;
  return (
    `${parsed.toolName}(path) rules are never matched by file permission checks ` +
    `(CLI ≥2.1.210) — use ${replacement}(${parsed.ruleContent}) instead.`
  );
}

export interface CommandPreviewResult {
  /** Render-safe text: every invisible character replaced by a visible escape. */
  text: string;
  /** How many invisible or control characters were made visible. */
  hiddenCount: number;
  /** Lines in `text`, so the caller can warn when the preview will scroll. */
  lineCount: number;
}

/**
 * Characters that occupy no visible width in a `<pre>` — zero-width spaces and
 * joiners, bidi overrides, soft hyphens, C0/C1 controls, the BOM, and the
 * line/paragraph separators. `\t` and `\n` are deliberately excluded: tabs get
 * their own visible glyph below, and newlines are meaningful in the preview.
 */
const INVISIBLE_RE =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Above this, the preview box scrolls and the tail is off-screen by default. */
const SCROLL_LINE_THRESHOLD = 8;

/**
 * Make a command safe to *show* in an approval dialog.
 *
 * OmniFex spawns the CLI with `--permission-prompt-tool stdio`, so this card is
 * the only place a human ever sees the command — the CLI's own dialog (which
 * gained this hardening in 2.1.223) never runs. Rendering `toolInput.command`
 * verbatim let a command pad itself with tabs, zero-width characters or bidi
 * overrides and display as something other than what would execute.
 *
 * Nothing is dropped: every neutralized character is replaced by its `<U+XXXX>`
 * escape and counted, so the preview stays a faithful account of the real
 * string rather than a prettier one.
 */
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

/**
 * One-line caution to show beside the preview, or null when there's nothing
 * unusual. Covers both ways a command can hide from a reviewer: characters
 * that don't render, and length that pushes the tail out of the scroll box.
 */
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

/**
 * Pull the initial editable rule string out of the first CLI suggestion, or
 * fall back to the bare tool name if the CLI didn't provide one.
 */
export function getInitialRuleString(
  suggestion: IncomingSuggestion | undefined,
  fallbackToolName: string,
): string {
  const r = suggestion?.rules?.[0];
  if (r?.toolName) {
    return r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName;
  }
  return (fallbackToolName || '').trim();
}
