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
 * Shipping the prompt as a constant fixes that. It is deliberately not
 * editable in the app: a saved copy froze the prompt at the version saved
 * (and "Reset to default" saved one), while the prompt's own last step is to
 * repair itself here, in the repo. The `cliReview.promptTemplate` override
 * and its Settings box were removed 2026-10-24.
 *
 * The prompt names files and symbols, never line numbers; its tests fail when
 * a named path or symbol goes away. The mechanical binary diffing lives in
 * `scripts/cli-review-diff.ts` (`npm run cli-review:diff`), where each check
 * is tested — it used to be hand-typed `rg` one-liners in this text.
 */

/**
 * Placeholders the app fills in before sending. Named rather than positional:
 * the old file used `$1`/`$2` and the command harness substituted them
 * inconsistently — `$1` arrived holding the *installed* version while `$2` was
 * left literal, so the prompt's own prose described the wrong range.
 */
export const REVIEWED_VERSION_PLACEHOLDER = '{reviewedVersion}';
export const INSTALLED_VERSION_PLACEHOLDER = '{installedVersion}';

export const CLI_REVIEW_PROMPT = `# Claude Code release review

Review every Claude Code release **after \`{reviewedVersion}\` up to and
including \`{installedVersion}\`** against this codebase, report what OmniFex
needs to do about it, and record the result.

\`{reviewedVersion}\` is the last release marked as checked (normally
\`REVIEWED_CLI_VERSION\` in \`electron/services/claude-cli-review.ts\`, unless a
later one was marked in the app without a build). \`{installedVersion}\` is the
CLI the user is running.

## Why this exists

OmniFex drives a CLI it does not ship. Any release can move a surface we
depend on, and there is no pinned dependency left to diff against. This
review is the only drift signal, so treat it as an audit: every claim needs a
grep, a file read or a transcript behind it.

## How this prompt stays true

- **The prompt carries the method; the code carries the inventory.** It names
  files and the symbols in them, never line numbers or counts. A test
  (\`src/lib/__tests__/cliReviewPrompt.test.ts\`) fails when a named path or
  symbol disappears, but it cannot see a surface that was never listed.
- **Fix what you find stale in the same change.** If a pointer here led
  nowhere, a check missed something, or a new kind of surface bit us, update
  this prompt (\`src/lib/cliReviewPrompt.ts\`), the diff script
  (\`scripts/cli-review-diff.ts\`) and their tests, and say so in the report.
  A prompt that only ever gets read gets thinner with every refactor.
- **Diff both ways.** Comparing version to version shows what moved in this
  range. Comparing the installed binary to OmniFex shows gaps that earlier
  reviews let through, which no range diff will ever show again.

## Steps

1. **Start from the history.** Read the header of
   \`electron/services/claude-cli-review.ts\` (\`REVIEWED_CLI_VERSION\`): the
   standing list of undocumented surface we drive, and the latest
   "Last review:" blocks. Note every item still marked open (gap, parked,
   not taken). Re-check those; don't re-derive them.

2. **Get the changelog entries.** Fetch
   \`https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md\`
   and take every entry in \`({reviewedVersion}, {installedVersion}]\`. If a
   version in the range has no entry, say so.

3. **Run the bundle diff.**

   \`\`\`sh
   npm run cli-review:diff -- {reviewedVersion} {installedVersion}
   \`\`\`

   It reads \`~/.local/share/claude/versions/<version>\` (set
   \`CLAUDE_VERSIONS_DIR\`, or pass a file path instead of a version, for any
   other location). It reports:
   - **version to version**: the merge-strategy map, every \`type:"…"\`
     literal, \`subtype:"…"\`, \`hook_event_name\`, \`control_*\` envelopes, the
     SDK's control requests, CLI flags, \`origin.kind\` values, the
     \`can_use_tool\` payload keys, every object key, the stream-json schemas'
     \`.describe()\` strings, and the \`/usage\` anchors;
   - **installed vs OmniFex**: record types we would draw as
     "Unrecognized record", hook events missing from \`HOOK_EVENTS\`, control
     subtypes we send and flags we pass that the binary no longer has, and
     SDK requests we never use.

   Read the output; don't just quote it. Lists stop at 40 items; add
   \`--full\` to see all of them. Do ad-hoc binary searches with \`node\`, not
   the shell's \`grep\`, which may be ugrep and refuses long bounded
   repeats.
   - Most movement is minifier renaming. Say which lines are real.
   - Exit 2 / \`ANCHOR NOT FOUND\` means the CLI or the script moved. An empty
     set is not a clean result: fix the script, then rerun.
   - A \`/usage\` anchor marked \`DROPPED\` is a reword until shown otherwise.
     The binary embeds its own changelog, which keeps quoting the old string,
     so a nonzero count can still mean the scraper is blind.
   - If \`{reviewedVersion}\` is not installed, the script still runs the
     coverage half. Say the version diff was skipped, and lean harder on
     step 4.
   - Before calling a coverage line a bug, check real transcripts under each
     account's \`projects/\` directory to see whether the CLI actually writes
     or sends it.

4. **Check what the script can't judge.**
   - **New fields on records we already classify.** In 2.1.277 the CLI
     started stamping stdin prompts \`turnOrigin:"sdk"\` and stopped naming
     sessions whose \`origin\` was absent. 36 sessions went nameless while
     every type set read clean. The script's object-key diff lists new keys,
     mostly noise. Read the context of any key that could sit on a
     \`user\` / \`assistant\` record, a permission request or an
     \`initialize\` reply.
   - **New \`.describe()\` text** is where the CLI writes down host
     obligations ("A host wrapping keyboard input must stamp
     {kind:'human'}"). Read every new or changed string the script lists.
   - **Attachment subtypes.** Unknown ones render as nothing, not as a
     card, so a new context source disappears silently. They show up in the
     \`type:"…"\` diff; decide whether \`src/lib/contextLedger.ts\`
     (\`IN_SCOPE\`, \`summariseContextAttachment\`) should take them.
   - **New CLI → host control requests.** \`electron/services/agents/claude-cli-engine.ts\`
     answers unknown ones with an error, so they don't stall a session.
     But a new one may be a capability the CLI now expects a host to serve.

5. **Map each entry and each real diff line to our surfaces.** Read the
   local code before saying something is or isn't affected. These are
   starting points. If an entry touches a surface missing from this list,
   handle it and add it here.

   - **Transcript records**: \`src/lib/jsonlClassifier.ts\` (\`classifyJsonlLine\`),
     \`src/lib/cliSidechannelRecords.ts\` (\`CLI_SIDECHANNEL_RECORD_TYPES\`),
     \`src/types/jsonl.ts\`, \`src/components/StreamMessage.tsx\`
   - **Stream-json I/O and the control protocol**:
     \`electron/services/agents/claude-cli-engine.ts\` (\`writeUserMessage\`, \`--permission-prompt-tool\`, \`control_request\`),
     \`electron/services/sessions/queries.ts\` (\`sendControlRequest\`, \`apply_flag_settings\`),
     \`electron/services/sessions/permissions.ts\`
   - **Session lifecycle and turn state**: \`docs/session-lifecycle.md\`,
     \`electron/services/sessions/stream-forward.ts\`
   - **Permission rules**: \`docs/permission-syntax.md\`, plus the official
     permissions docs
   - **Hooks**: \`src/types/hooks.ts\` (\`HOOK_EVENTS\`), \`src/components/HooksEditor.tsx\`
   - **\`/usage\` scraping**: \`electron/services/usage-runner.ts\`,
     \`electron/services/usage-runner/parser.ts\`
   - **Models, effort, thinking, fast mode**: \`electron/services/models.ts\` (\`initialize\`),
     \`src/lib/pricing.ts\` (\`SHIPPED_PRICING\`), \`src/lib/api.ts\` (\`startSession\`).
     A new model needs a price row as well as a picker entry.
   - **Mods, plugins, MCP**: \`electron/services/sessions/mods.ts\`,
     \`electron/services/sessions/plugins.ts\`, \`electron/services/bundled-mod.ts\`,
     \`electron/services/mcp.ts\`, \`omnifex-mod/\`
   - **The Brain's MCP server**: \`electron/brain-mcp.ts\`,
     \`electron/services/brain/instructions.ts\`,
     \`electron/services/brain/mcp-registration.ts\` (\`--mcp-config\`).
     How the CLI treats server \`instructions\` decides whether the Brain is
     used at all.
   - **OmniFex's own \`claude -p\` runs**: \`electron/services/sessions/summary-query.ts\`,
     \`electron/services/sessions/internal-spend.ts\`
   - **Where transcripts live**: \`electron/services/project-paths.ts\` (\`encodeProjectId\`).
     Encoding or relocation changes strand history and spend.
   - **Locating and updating the CLI**: \`electron/services/claude-binary.ts\`,
     \`electron/services/claude-cli-review.ts\`
   - **Slash commands and settings keys**: \`electron/services/slash-commands.ts\`,
     \`electron/services/commands-catalog.ts\`, \`electron/services/claude.ts\`

6. **Report.** Lead with one line: is the current build broken? Then, for
   each entry or diff line that matters: what changed, the OmniFex files it
   touches (\`file:line\`), and which it is:
   - (a) already handled
   - (b) a bug we now have
   - (c) an opportunity worth taking

   Put everything else on one "no OmniFex impact" list, and list the open
   items carried from step 1 with their status.

7. **Recommend, don't sprawl.** Propose the smallest set of follow-ups,
   most broken first. Ask before implementing anything beyond a trivial fix.

8. **Record it. Always, because recording is how every review ends.**
   - Set \`REVIEWED_CLI_VERSION\` to \`{installedVersion}\`.
   - Add a "Last review:" block above the existing ones. It records what you
     found, including the inert entries and the diff lines you judged to be
     noise, so the next reviewer doesn't re-derive them. It also lists every
     open item still standing, so step 1 of the next review finds them in
     one place.
   - Do this even when the answer is "nothing to change". A clean pass is a
     result.
   - This needs no separate go-ahead. The source watermark is what the next
     build was reviewed against.
   - What is forbidden is bumping it without doing the work. The block is
     the evidence that the review happened.

   The bump doesn't clear the drift badge. The user does that with "Mark
   \`{installedVersion}\` as checked" in the Updates popover, after reading
   your report. End by telling them so.

## Notes

- For anything the changelog only gestures at, check official Anthropic docs
  rather than memory. The repo-local \`version-aware-research\` skill applies.
- The changelog is terse. "Fixed a rendering issue" can be the entry that
  broke the scraper. Check the surface; don't trust the summary.
`;

/**
 * Fill the version placeholders.
 *
 * Splits and joins rather than `String.replace`: `replace` reads `$&`, `$1`
 * and friends in a *replacement string* as backreferences, so a version
 * containing one would otherwise smear the matched text through the prompt.
 */
export function renderCliReviewPrompt(reviewedVersion: string, installedVersion: string): string {
  return CLI_REVIEW_PROMPT
    .split(REVIEWED_VERSION_PLACEHOLDER)
    .join(reviewedVersion)
    .split(INSTALLED_VERSION_PLACEHOLDER)
    .join(installedVersion);
}
