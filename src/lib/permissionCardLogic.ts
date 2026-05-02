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
  const match = rule.match(/^([A-Za-z_][A-Za-z0-9_]*)\((.+)\)$/);
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

/** Build the `updatedPermissions` entry for the current SDK session only. */
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
 * Pull the initial editable rule string out of the first SDK suggestion, or
 * fall back to the bare tool name if the SDK didn't provide one.
 */
export function getInitialRuleString(
  suggestion: IncomingSuggestion | undefined,
  fallbackToolName: string,
): string {
  const r = suggestion?.rules?.[0];
  if (r && r.toolName) {
    return r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName;
  }
  return (fallbackToolName || '').trim();
}
