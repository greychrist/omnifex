/**
 * Reconciling the settings-file permissions panel with the live session.
 *
 * `SessionPermissionsEditor` builds its view by reading three settings files
 * (`electron/services/permissions-io.ts`), which is all OmniFex had before CLI
 * 2.1.269. That view has two structural blind spots:
 *
 *  - It reads `permissions.allow` and `permissions.deny` only, so an `ask` rule
 *    in the very same file is invisible — and "Add Rule" cannot create one.
 *  - It models three of the CLI's eleven rule sources, so policy rules,
 *    `--allowedTools` grants, slash-command grants and session-only approvals
 *    never appear at all.
 *
 * `list_permission_rules` reports what the session actually holds. These
 * helpers turn that into the delta worth showing the user, rather than a second
 * copy of a list they already have.
 *
 * Everything here is pure. `null` in means "the CLI gave no answer" (a
 * pre-2.1.269 CLI) and must yield an empty delta, never a claim that the
 * session has no rules.
 */
import type { CliPermissionRule, CliPermissionRuleSource, CliPermissionRulesState } from '@/lib/api';

/** The sources the settings-file panel can read and write. */
export const FILE_RULE_SOURCES = [
  'userSettings',
  'projectSettings',
  'localSettings',
] as const satisfies readonly CliPermissionRuleSource[];

const FILE_SOURCES = new Set<string>(FILE_RULE_SOURCES);

export interface LiveRuleDelta {
  /** In the session, but the file panel structurally cannot display it. */
  hidden: CliPermissionRule[];
  /** In a settings file and shown by the panel, but the session ignores it. */
  ignored: CliPermissionRule[];
  /** True when managed settings pin `allowManagedPermissionRulesOnly`. */
  managedOnly: boolean;
}

/**
 * What the live session knows that the settings-file panel does not.
 *
 * `flagSettings` is excluded from `hidden` on purpose: that source is where
 * OmniFex's own `applyPermissions` push lands, so surfacing it would show the
 * user their own file-derived rules echoed back as if they were news.
 */
export function diffLiveRules(state: CliPermissionRulesState | null | undefined): LiveRuleDelta {
  if (!state) return { hidden: [], ignored: [], managedOnly: false };

  const hidden: CliPermissionRule[] = [];
  const ignored: CliPermissionRule[] = [];

  for (const rule of state.rules ?? []) {
    // Reported once. An ignored rule is already on screen via its file; the
    // useful fact is that it is dead, not that it exists.
    if (rule.notInEffect) {
      ignored.push(rule);
      continue;
    }
    if (rule.source === 'flagSettings') continue;
    if (!FILE_SOURCES.has(rule.source) || rule.behavior === 'ask') {
      hidden.push(rule);
    }
  }

  return { hidden, ignored, managedOnly: state.managedOnly === true };
}

/**
 * The CLI's plain-language reading of a rule, as one string.
 *
 * The CLI splits it into fixed words (`prefix`/`suffix`) around the rule
 * content (`emphasis`) so a host can bold the content the way the terminal
 * does. We join it for a single-line subtitle; React escapes the result, which
 * matters because `emphasis` can carry invisible characters by design.
 *
 * Falls back to the verbatim rule where the CLI offers no description — the
 * terminal shows no subtitle in that case either.
 */
export function describeRule(rule: CliPermissionRule): string {
  const d = rule.description;
  if (!d) return rule.rule;
  return [d.prefix, d.emphasis, d.suffix].filter((p) => p && p.length > 0).join(' ');
}
