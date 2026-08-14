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

/**
 * Deliberately short. This costs a real turn every time it fires, and a long
 * preamble buys nothing over the one instruction that matters.
 */
export const DEFAULT_POST_COMPACT_PROMPT = `The conversation above was just compacted: what you have of the earlier turns is now a lossy summary, not the original text.

Before you state anything specific that came from before the compaction — a file path, a line number, a command's output, a test result, an error string, a config value — re-read the source and quote it. Do not reconstruct it from the summary, and do not reformat captured output into a shape it did not have.

If you were mid-task, say in one line what you were doing and what you have verified since re-reading, then carry on.`;

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
