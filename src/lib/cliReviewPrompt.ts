/**
 * The changelog-review prompt the Updates popover's drift warning launches.
 *
 * This used to live in `.claude/commands/cli-changelog-review.md` so it could
 * be edited without rebuilding the app. That worked on the author's machine and
 * nowhere else: `.gitignore` ignores `.claude/`, so the file was never in the
 * repo, never seeded on first run, and had no user-scope copy. Anyone who
 * cloned OmniFex and clicked the drift warning got a session that fired a slash
 * command the CLI had never heard of.
 *
 * Shipping the prompt as a constant fixes that, and a user override in
 * `app_settings` keeps it editable without a rebuild — the same shape as the
 * session-summary prompt (`DEFAULT_SUMMARY_PROMPT` +
 * `sessionsSummary.promptTemplate`).
 */

/** app_settings key holding the user's edited review prompt, if any. */
export const CLI_REVIEW_PROMPT_SETTING_KEY = 'cliReview.promptTemplate';

/**
 * Placeholders the app fills in before sending. Named rather than positional:
 * the old file used `$1`/`$2` and the command harness substituted them
 * inconsistently — `$1` arrived holding the *installed* version while `$2` was
 * left literal, so the prompt's own prose described the wrong range.
 */
export const REVIEWED_VERSION_PLACEHOLDER = '{reviewedVersion}';
export const INSTALLED_VERSION_PLACEHOLDER = '{installedVersion}';

export const DEFAULT_CLI_REVIEW_PROMPT = `# CLI Changelog Review

Review every Claude Code release **after \`{reviewedVersion}\` up to and
including \`{installedVersion}\`** against this codebase, and report what OmniFex
needs to do about it.

\`{reviewedVersion}\` is \`REVIEWED_CLI_VERSION\` in
\`electron/services/claude-cli-review.ts\`; \`{installedVersion}\` is the CLI the
user is actually running.

## Why this exists

OmniFex drives a CLI it does not ship. Every release can move a surface we
depend on, and the old \`@anthropic-ai/claude-agent-sdk\` dependency that used to
pin a version to diff against is gone. This review is the only drift signal
left — treat it as a real audit, not a formality.

## Steps

1. **Get the entries.** Fetch
   \`https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md\`
   and take every entry in the range \`({reviewedVersion}, {installedVersion}]\`.
   If a version in the range is missing from the changelog, say so rather than
   silently skipping it.

2. **Map each entry to our surfaces.** For every entry, decide whether it
   touches something OmniFex depends on. Read the local code before claiming it
   does or doesn't — this is an evidence exercise, not a vibe check. The
   surfaces that have actually bitten us:

   - **JSONL stream shapes** — \`src/types/jsonl.ts\`, the parsing in
     \`electron/services/sessions/\`, \`src/components/StreamMessage.tsx\`
   - **Control requests / responses** — \`electron/services/sessions/runtime.ts\`,
     \`permissions.ts\` (permission-prompt-tool stdio decider, \`apply_flag_settings\`)
   - **TUI rendering we scrape** — \`electron/services/usage-runner.ts\` (\`/usage\`),
     the session-control-state detection in \`electron/services/sessions/tui.ts\`
   - **Hook event names + payloads** — \`electron/services/claude.ts\` hooks config
   - **Permission-rule semantics** — \`docs/permission-syntax.md\`, the rules UI
   - **Session lifecycle / status** — \`docs/session-lifecycle.md\`
   - **Model, effort, thinking, fast-mode plumbing** — \`src/lib/api.ts\`
     \`startSession\` params and the pickers that feed it
   - **Slash commands, subagents, MCP, plugins, settings.json keys**

3. **Report.** For each entry that matters: what changed, which OmniFex files
   are affected, and whether it is (a) already handled, (b) a bug we now have,
   or (c) an opportunity worth taking. Cite \`file:line\`. Group the rest under a
   one-line "no OmniFex impact" list — don't pad the report with them.

4. **Recommend, don't sprawl.** Propose the smallest set of follow-ups, ordered
   by whether the current build is actually broken. Ask before implementing
   anything beyond a trivial fix.

5. **Bump the watermark ONLY on explicit go-ahead.** When the user says so,
   update \`REVIEWED_CLI_VERSION\` to \`{installedVersion}\` in
   \`electron/services/claude-cli-review.ts\` and its "Last review:" comment line.
   Bumping it to silence the badge without doing the work throws away the only
   drift signal we have.

## Notes

- Prefer official Anthropic docs over model memory for anything the changelog
  only gestures at. The repo-local \`version-aware-research\` skill applies.
- The changelog is terse. An entry like "fixed a rendering issue" can still be
  the thing that broke our scraper — check the surface, don't trust the summary.
`;

/**
 * Fill the version placeholders in `template`, falling back to the shipped
 * default when the user hasn't stored one (or has blanked the box).
 *
 * Uses a replacer function rather than a string replacement: `String.replace`
 * reads `$&`, `$1` and friends in a *replacement string* as backreferences, so
 * a version containing one would otherwise smear the matched text through the
 * prompt.
 */
export function renderCliReviewPrompt(
  template: string | null | undefined,
  reviewedVersion: string,
  installedVersion: string,
): string {
  const source = template && template.trim() ? template : DEFAULT_CLI_REVIEW_PROMPT;
  return source
    .split(REVIEWED_VERSION_PLACEHOLDER)
    .join(reviewedVersion)
    .split(INSTALLED_VERSION_PLACEHOLDER)
    .join(installedVersion);
}
