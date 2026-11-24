// A standing CLAUDE.md instruction is itself compacted away just when it matters; this arrives as a fresh turn after the boundary.

export const POST_COMPACT_PROMPT_SETTING_KEY = 'postCompact.promptTemplate';

/** `'false'` is off; anything else, including no row, is on. */
export const POST_COMPACT_ENABLED_SETTING_KEY = 'postCompact.enabled';

/** Deliberately short: it costs a real turn, and a "carry on" line set off work nobody asked for. */
export const DEFAULT_POST_COMPACT_PROMPT = `The conversation above was just compacted; earlier turns are now a lossy summary. Before relying on a specific detail from before the compaction — a path, line number, command output, test result, error text, config value — re-read just that source rather than trusting the summary. Don't re-read anything you aren't about to use.`;

export function resolvePostCompactPrompt(
  template: string | null | undefined,
): string {
  return template?.trim() ? template : DEFAULT_POST_COMPACT_PROMPT;
}

export function resolvePostCompactDirective(
  enabled: string | null | undefined,
  template: string | null | undefined,
): string {
  return enabled === 'false' ? '' : resolvePostCompactPrompt(template);
}
