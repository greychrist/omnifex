/**
 * The directive OmniFex sends into a session immediately after a compaction.
 *
 * Compaction replaces the earlier turns with a summary. The summary keeps the
 * shape of what happened and loses the specifics — the exact line number, the
 * literal stderr line, the value a command actually printed. A model working
 * from it will still answer confidently about those specifics, reconstructing
 * them from the gist, and the reconstruction looks exactly like a memory.
 *
 * So the moment the context goes lossy, we say so. The placement is the point:
 * a standing instruction in CLAUDE.md is loaded at session start and is itself
 * compacted away right when it becomes relevant, whereas this arrives as a
 * fresh turn on the near side of the boundary.
 *
 * Sent automatically — see `queuePostCompactDirective` in
 * `sessionStreamEffects.ts` for the queueing, and the `compact_boundary` branch
 * of `sessionStreamReducer.ts` for the trigger (which covers auto-compaction
 * and a hand-typed `/compact`, not just OmniFex's own banner click).
 *
 * Shipped as a constant with an `app_settings` override, the same shape as
 * `DEFAULT_CLI_REVIEW_PROMPT` + `cliReview.promptTemplate` and
 * `DEFAULT_SUMMARY_PROMPT` + `sessionsSummary.promptTemplate`.
 */

/** app_settings key holding the user's edited directive, if any. */
export const POST_COMPACT_PROMPT_SETTING_KEY = 'postCompact.promptTemplate';

/** app_settings key for the on/off switch. `'false'` is off; anything else,
 *  including no row, is on. */
export const POST_COMPACT_ENABLED_SETTING_KEY = 'postCompact.enabled';

/**
 * Deliberately short. This costs a real turn every time it fires, and a long
 * preamble buys nothing over the one instruction that matters.
 *
 * It used to end "If you were mid-task, say in one line what you were doing …
 * then carry on", and ask the model to quote what it re-read. Over 52
 * compactions the re-reads proved rare, but as its own turn "carry on" set off
 * work nobody had asked for, and the quoting padded replies. Both went; the
 * last line keeps re-reading to what the next answer actually needs.
 */
export const DEFAULT_POST_COMPACT_PROMPT = `The conversation above was just compacted; earlier turns are now a lossy summary. Before relying on a specific detail from before the compaction — a path, line number, command output, test result, error text, config value — re-read just that source rather than trusting the summary. Don't re-read anything you aren't about to use.`;

/**
 * Fill in the user's override, falling back to the shipped default when they
 * haven't stored one or have blanked the box.
 *
 * No placeholder substitution here, unlike `renderCliReviewPrompt` — the
 * directive says the same thing regardless of session, so there is nothing to
 * interpolate and nothing to get wrong.
 */
export function resolvePostCompactPrompt(
  template: string | null | undefined,
): string {
  return template && template.trim() ? template : DEFAULT_POST_COMPACT_PROMPT;
}

/**
 * What to send after a compaction: the resolved prompt, or `''` when the user
 * switched the directive off. The switch is the only way to turn it off, so
 * an edited prompt survives being turned off and on again.
 */
export function resolvePostCompactDirective(
  enabled: string | null | undefined,
  template: string | null | undefined,
): string {
  return enabled === 'false' ? '' : resolvePostCompactPrompt(template);
}
