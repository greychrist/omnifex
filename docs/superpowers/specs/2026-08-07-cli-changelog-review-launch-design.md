# Clickable CLI-changelog-drift warning → review session

**Date:** 2026-08-07
**Status:** approved

## Problem

The Updates popover already tells you when the installed Claude CLI has moved
past the changelog watermark this build was reviewed against:

> Claude Code is ahead of the 2.1.222 changelog OmniFex was last checked
> against — there may be new CLI behaviour to support.

That message is a dead end. Acting on it means leaving the popover, finding the
OmniFex repo in the project list, starting a session, and typing out the review
prompt from memory — enough friction that the badge gets ignored and drift
accumulates (the watermark has repeatedly sat several releases behind).

Make the warning the action: one click launches a Claude session in the OmniFex
repo running the changelog review for exactly the version range that's drifted.

## Design

### 1. Repo path resolution (main process)

`CliReviewStatus` gains `repo_dir: string | null` — the OmniFex source checkout
to run the review in. `createClaudeCliReviewService` resolves it, so the logic
is unit-testable rather than buried in `main.ts`:

1. `cli_review_repo_dir` app setting, when set and the directory exists
2. `process.cwd()` in dev (`!app.isPackaged`), when it is an OmniFex checkout
3. Otherwise, the first known project path that is an OmniFex checkout
4. `null`

"Is an OmniFex checkout" means `package.json` in that directory parses and its
`name` is `omnifex`. Identity, not a hardcoded path: the packaged app (which is
the build Greg actually runs, where `process.cwd()` is meaningless) finds the
repo among the projects it already knows about, and nobody else's install gets a
stray `/Users/gregorychristie/...` default.

Discovery caches positive results for the process lifetime. Negative results are
not cached — cloning the repo shouldn't require an app restart to be noticed.

`getStatus()` becomes async, because project paths come from
`claudeService.listProjects()`. The IPC `wrap()` already awaits, and the
renderer already awaits, so this is contained.

Settings → General grows a "Claude Code changelog review" section with a path
input plus a folder picker, writing `cli_review_repo_dir`. It is an override:
empty means "use discovery", which is the normal state.

### 2. The click target (renderer)

The amber block in `CustomTitlebar.tsx` becomes a real `<button>` when
`repo_dir` is non-null, with a "Review it →" affordance line. Radix keeps
tooltip content open while the pointer is over it, so the button is reachable
without converting the whole popover to a click-open surface.

When `repo_dir` is null the block stays plain text and gains a one-line hint
pointing at the Settings field — no dead click target.

### 3. What the click does

New `src/lib/cliReviewLaunch.ts` owns the launch payload, shared with the
project view's Quick Launch instead of duplicating it (`slotToResolution` moves
here from `TabContent.tsx`):

- `buildCliReviewPrompt(reviewed, installed)` → `/cli-changelog-review 2.1.222 2.1.224`
- `buildLaunchTab({ projectPath, pair, prompt })` → the chat-tab fields, or a
  no-account result the caller renders as the existing guidance rather than
  launching accountless

`App.tsx` wires the titlebar callback: resolve the account for `repo_dir`, add a
chat tab with `initialSessionConfig` (Claude engine, the account's session
defaults, rich mode) plus a new `initialPrompt`, switch to the tabs view, focus
it.

### 4. `initialPrompt` on `Tab`

`Tab` gains `initialPrompt?: string`. `AgentSession` sends it once, in the
`'fresh-start'` branch of the auto-start effect **after** `startPersistentSession()`
resolves — sending it earlier would race the auto-start and spawn a second CLI
process, since `handleSendPrompt` starts a session when
`persistentSessionRef.current` is false.

Guarded by a ref and cleared from the tab record after firing, so a persisted
and restored tab doesn't re-send the prompt on the next app launch.

### 5. The review command

`.claude/commands/cli-changelog-review.md`, taking `$1` (reviewed watermark) and
`$2` (installed version):

- fetch `anthropics/claude-code` `CHANGELOG.md`
- take the entries in `($1, $2]`
- map each against the surfaces OmniFex depends on: JSONL shapes, control
  requests, `/usage` rendering, hook event names, permission-rule semantics,
  session lifecycle, model/effort/fast-mode plumbing
- report what needs work, with file pointers
- bump `REVIEWED_CLI_VERSION` only on explicit go-ahead

Keeping the procedure in the repo means it can be edited without rebuilding the
app; the app only supplies the version range.

## Tests

- `electron/__tests__/claude-cli-review.test.ts` — `repo_dir` resolution: setting
  wins, non-existent setting falls through, dev cwd, project-path discovery,
  null when nothing matches, positive-result caching
- `src/lib/__tests__/cliReviewLaunch.test.ts` — prompt formatting; tab payload
  carries the account's model/effort/permission defaults; no-account case
- `src/components/__tests__/CustomTitlebar.cliReview.test.tsx` — button only when
  `repo_dir` is present, click reports the right version range, plain text +
  hint otherwise

## Verification

`npm run check`, `npm test`, `npm run build`, then `npm run rebuild:electron`.
