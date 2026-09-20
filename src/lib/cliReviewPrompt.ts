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
   - **TUI rendering we scrape** — \`electron/services/usage-runner.ts\` (\`/usage\`)
   - **Hook event names + payloads** — \`electron/services/claude.ts\` hooks config
   - **Permission-rule semantics** — \`docs/permission-syntax.md\`, the rules UI
   - **Session lifecycle / status** — \`docs/session-lifecycle.md\`
   - **Model, effort, thinking, fast-mode plumbing** — \`src/lib/api.ts\`
     \`startSession\` params and the pickers that feed it
   - **Slash commands, subagents, MCP, plugins, settings.json keys**

3. **Diff the binaries, not just the prose.** The changelog is not the whole
   surface: a record type can ship without an entry. Installed versions live in
   \`~/.local/share/claude/versions/<version>\` and are greppable JS
   (\`rg -a\`). With two versions in the range installed, diff at least:

   - **The JSONL record-type map** — the CLI's merge-strategy map. One object
     mapping every record type it writes into a session file to a strategy, with
     exactly four — \`user\`, \`assistant\`, \`system\`, \`attachment\` — tagged
     \`"transcript"\` and the rest being per-session bookkeeping. Find it via a
     key you know is in it and widen to the enclosing object:

     \`\`\`sh
     rg -a -o '\\{[^{}]{0,1200}"atis-latch":"[a-z-]+"[^{}]{0,600}\\}' \\
       ~/.local/share/claude/versions/<version>
     \`\`\`

     A new entry is a new record type. Decide which it is: something OmniFex
     must render (add a case to \`src/lib/jsonlClassifier.ts\`), or bookkeeping
     (add it to \`src/lib/cliSidechannelRecords.ts\`). Left undecided it becomes
     an orange "Unrecognized record" card on every occurrence — which is how
     \`atis-latch\` reached hundreds of cards before anyone noticed.
   - \`subtype:"…"\` literals, \`hook_event_name\` literals, \`type:"control_*"\`
     envelopes, and the \`/usage\` anchors \`usage-runner/parser.ts\` reads.
   - **The keys on \`user\` / \`assistant\` records**, not just the record
     \`type:\` literals. A field can appear on a record we already classify and
     change what the CLI does with it: 2.1.277 started stamping stdin prompts
     \`turnOrigin:"sdk"\` and stopped auto-naming sessions whose \`origin\`
     was absent — 36 sessions went nameless while the record-type map read
     "clean". Compare the allowed-value lists too (the \`turnOrigin\`
     sanitizer set is one \`var\`). Fix on our side was one field:
     \`origin:{kind:"human"}\` in \`claude-cli-engine.ts\` writeUserMessage.
   - **The stream-json input schemas' \`.describe()\` strings** — the CLI
     documents host obligations there ("A host wrapping keyboard input must
     stamp {kind:'human'} explicitly"). Grep \`type:R("user")\` and read the
     fields' descriptions, not only their names.
   - **The SDK client's control subtypes** vs ours:
     \`rg -a -o 'this\\.request\\(\\{subtype:"[a-z_]+"'\` in the bundle lists what
     an SDK host can ask for; \`sendControlRequest('…')\` in
     \`electron/services/sessions/queries.ts\` is what we ask for. A new
     subtype is a capability we may be missing, not just noise.

   Report counts both ways round. Most movement is minifier noise — identifier
   renaming shifts occurrence counts without changing the literal set — so say
   which it is rather than reporting a number that moved.

4. **Report.** For each entry that matters: what changed, which OmniFex files
   are affected, and whether it is (a) already handled, (b) a bug we now have,
   or (c) an opportunity worth taking. Cite \`file:line\`. Group the rest under a
   one-line "no OmniFex impact" list — don't pad the report with them.

5. **Recommend, don't sprawl.** Propose the smallest set of follow-ups, ordered
   by whether the current build is actually broken. Ask before implementing
   anything beyond a trivial fix.

6. **Bump the watermark. Always — it is the closing step of every review.**
   Update \`REVIEWED_CLI_VERSION\` to \`{installedVersion}\` in
   \`electron/services/claude-cli-review.ts\`, and add a "Last review:" block
   above the existing ones recording what you found — including the entries
   that turned out to be inert, so the next reviewer does not re-derive them.

   This does not need its own go-ahead. An unbumped watermark means the next
   review re-runs this same range, and the drift badge stops meaning anything.
   Do it even when the answer is "nothing to change" — a clean pass is a
   result, and recording it is the point.

   What is forbidden is bumping it *without* doing the work. The comment block
   is the evidence that the work happened; a bump with nothing to say is the
   one thing that throws away the only drift signal we have.

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
