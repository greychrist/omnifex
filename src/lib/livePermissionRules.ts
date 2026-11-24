// A null state means the CLI gave no answer (pre-2.1.269): an empty delta, never "no rules".
import type { CliPermissionRule, CliPermissionRuleSource, CliPermissionRulesState } from '@/lib/api';

export const FILE_RULE_SOURCES = [
  'userSettings',
  'projectSettings',
  'localSettings',
] as const satisfies readonly CliPermissionRuleSource[];

const FILE_SOURCES = new Set<string>(FILE_RULE_SOURCES);

export interface LiveRuleDelta {
  hidden: CliPermissionRule[];
  ignored: CliPermissionRule[];
  managedOnly: boolean;
}

/** `flagSettings` is excluded from `hidden`: OmniFex's own applyPermissions push lands there. */
export function diffLiveRules(state: CliPermissionRulesState | null | undefined): LiveRuleDelta {
  if (!state) return { hidden: [], ignored: [], managedOnly: false };

  const hidden: CliPermissionRule[] = [];
  const ignored: CliPermissionRule[] = [];

  for (const rule of state.rules ?? []) {
    if (rule.notInEffect) {
      ignored.push(rule);
      continue;
    }
    if (rule.source === 'flagSettings') continue;
    if (!FILE_SOURCES.has(rule.source) || rule.behavior === 'ask') {
      hidden.push(rule);
    }
  }

  return { hidden, ignored, managedOnly: state.managedOnly };
}

/** React escapes the result, which matters: `emphasis` can carry invisible characters by design. */
export function describeRule(rule: CliPermissionRule): string {
  const d = rule.description;
  if (!d) return rule.rule;
  return [d.prefix, d.emphasis, d.suffix].filter((p) => p && p.length > 0).join(' ');
}
