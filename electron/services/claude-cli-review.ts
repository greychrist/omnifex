import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Claude Code changelog watermark.
 *
 * OmniFex wraps a CLI it does not ship: `claude` updates itself on the user's
 * machine, and each release can move a surface we depend on (JSONL shapes,
 * control-request names, `/usage` rendering, hook event names, permission-rule
 * semantics). The old `@anthropic-ai/claude-agent-sdk` dependency gave us a
 * pinned version to diff against; driving the binary directly took that away.
 *
 * This module restores the signal without restoring the dependency: a constant
 * recording the newest release whose changelog has actually been read against
 * this codebase, compared against the version of the binary the user is
 * running. When the CLI is ahead, the Updates button says so.
 *
 * The changelog itself lives at
 * https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md — not
 * carried in the payload, since nothing in the renderer can open a URL yet.
 */

/**
 * Newest Claude Code release whose changelog has been reviewed against this
 * codebase.
 *
 * Bump this ONLY as part of a real review pass — read every entry between the
 * old value and the new one, and file or fix whatever they imply. Bumping it
 * to silence the badge throws away the only drift signal we have.
 *
 * Last review: 2.1.235 -> 2.1.236 on 2026-08-19. Findings:
 *
 *  1. `/usage` letter loss — REAL BUG, FIXED. Not a 2.1.236 regression; found
 *     while checking 2.1.236's new usage-credits row against a live capture.
 *     The CLI paints that dialog with a DIFFING renderer: after the first
 *     paint it re-emits only the cells that changed and steps over the rest
 *     with `ESC[<n>G` / `ESC[<n>C` / `ESC[<n>B` — and `ESC[<n>B` moves down
 *     WITHOUT resetting the column. `ansi.ts` was a linear "escape -> one
 *     space" stripper, so every stepped-over cell was dropped:
 *     `/omnifex-release` parsed as `/ mnifex-rele se`, `mcp-atlassian` as
 *     `mc -atlassian`, `general-purpose` as `g neral-purpose`. No amount of
 *     space arithmetic recovers those — the character exists only in the
 *     screen grid. `stripAnsi` is now a screen replay (grid + cursor motion +
 *     erase ops), which made `usage-runner/repair.ts` dead and deleted it.
 *     The pty grew from rows 60 -> 200 because the grid returns the SCREEN,
 *     and at 60 rows the dialog scrolls with the ranked tables below the fold.
 *
 *  2. `Current week (Fable)` — REAL BUG, FIXED. 2.1.236 renders a per-model
 *     weekly bar that is not Sonnet. The header regex required `Son` inside
 *     the parens, so the window never reached the popover or `rate_limits`.
 *     Per-model bars come from a generic `limits` array CLI-side, so the set
 *     is open: windows are now discovered (`findWindows` -> `week_<model>`,
 *     `rateLimitTypeForWindow` -> `seven_day_<model>`) and an unrecognised
 *     label raises a drift warning instead of vanishing. `isUsageOutputComplete`
 *     no longer demands a Sonnet bar by name; it keys "the window list is
 *     finished" on the contributing header, which renders below every window.
 *
 *  3. `ANTHROPIC_DEFAULT_MODEL` — new env var, and it outranks the
 *     settings.json `model` pin. Verified in the binary:
 *     `t.model || process.env.ANTHROPIC_MODEL || V.ANTHROPIC_DEFAULT_MODEL`.
 *     `--model` still wins, so explicit picks are unaffected — but OmniFex
 *     omits `--model` for "Account Default" and every spawn inherits
 *     `process.env`, and `AgentSession` was sizing the context gauge from
 *     `getClaudeSettings().model` alone. Added `claude.getDefaultModel()` +
 *     the `get_claude_default_model` channel, which resolves the same order
 *     the CLI does and reports which source won.
 *
 *  4. RETRACTED, recorded so it is not "rediscovered": the new usage-credits
 *     row does NOT donate its `Resets` line to the Sonnet window. That claim
 *     came from reading minified JSX child order; a live capture shows the
 *     credits row renders BELOW the contributing section and the tables
 *     footer, and `SECTION_HEADERS.contributing` already bounded every window
 *     slice. Minified child order is not evidence — capture the screen.
 *
 *  5. SIGTERM in print/SDK mode no longer records an interrupted turn or
 *     synthetic tool denials (the handler sets a `committed` latch, kills
 *     child processes, exits 143). No action: we interrupt via a control
 *     request, not a signal, and SIGTERM only fires from `close()` at
 *     teardown — where `sessionStatus` is `stopped` and the in-flight rollup
 *     is already false. Residual, cosmetic: a session killed mid-turn now
 *     leaves a transcript that simply stops, with no interruption marker.
 *
 *  6. Slash-command typos no longer fuzzy-match. No action, but verified
 *     rather than assumed: `usage-runner.ts` sends `/usage` (exact) and
 *     `/quit`, and `/quit` is a REGISTERED ALIAS of `/exit` in the binary
 *     (`aliases:["quit"]`). The entry preserves prefixes and aliases.
 *
 *  7. The managed-settings approval prompt no longer captures the first
 *     keypress while invisible — a fix that removes a real failure mode for
 *     the `/usage` pty automation, which types into whatever screen is up.
 *     Deliberately NOT given a marker in the readiness loop: the dialog's
 *     wording could not be verified from the binary and it cannot appear
 *     without an org policy file, so hardcoding a guess is the brittleness
 *     this review exists to catch. Instead the startup timeout now logs the
 *     rendered screen plus the markers it was waiting for.
 *
 * Fixed upstream, no action needed: the fullscreen renderer now falls back to
 * the classic renderer instead of failing permanently after one bad start
 * (that failure mode would have broken TUI sessions and the `/usage` scrape
 * alike). Watch item, not a finding: `ansi.ts` models the classic renderer, so
 * if fullscreen ever becomes the default it needs re-verification.
 *
 * Everything else in 2.1.236 is out of reach: `notify_when_idle` on
 * SendMessage (we never call it), the sandbox wildcard read-deny precedence
 * change and the auto-mode Monitor-rule change (no sandbox or Monitor surface
 * here), recap capping at 400 chars (content-only — `away_summary` still
 * carries its text in `content`), the `/model` picker height and highlight
 * (we mirror the model from JSONL, not the picker), tmux title throttling
 * (OSC is stripped), `/goal` idle check-ins, Remote Control offline marking,
 * footer alignment, the cwd-removed and subprocess-start fixes, the guest-pass
 * `~/.claude.json` fix (we read-modify-write that file, never replace it), and
 * the VSCode screen-reader work.
 */
export const REVIEWED_CLI_VERSION = '2.1.236';

/**
 * app_settings key holding the user's explicit OmniFex-checkout override.
 * Mirrored as `CLI_REVIEW_REPO_DIR_SETTING_KEY` in `src/lib/api.ts` — the
 * renderer can't import from `electron/`.
 */
export const CLI_REVIEW_REPO_DIR_SETTING_KEY = 'cli_review_repo_dir';

export interface CliReviewStatus {
  /** Parsed version of the installed binary, or null if not found/probed. */
  installed_version: string | null;
  /** The watermark this build was reviewed against. */
  reviewed_version: string;
  /** True when the installed CLI is strictly newer than the watermark. */
  unreviewed: boolean;
  /**
   * OmniFex source checkout to run the changelog review in, or null when we
   * can't find one. The renderer only makes the drift warning clickable when
   * this is set — a launch button with nowhere to launch is worse than text.
   */
  repo_dir: string | null;
}

export interface ClaudeCliReviewService {
  getStatus(): Promise<CliReviewStatus>;
}

/**
 * Default probe: run `--version` on an already-resolved binary path.
 *
 * Takes a path rather than the bare command name on purpose. `execSync` runs
 * through `/bin/sh -c`, which never expands interactive shell aliases, so a
 * user who has aliased `claude` away in their shell rc is unaffected either
 * way — but resolving through claude-binary.ts keeps this consistent with the
 * binary every other OmniFex code path actually spawns.
 */
export function probeCliVersion(binaryPath: string | null): string | null {
  if (!binaryPath) return null;
  try {
    const out = execSync(`"${binaryPath}" --version`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Is `dir` an OmniFex source checkout?
 *
 * Identified by `package.json` name rather than by path, so the packaged app —
 * where `process.cwd()` is meaningless — can find the repo among the projects
 * the user already works in, without anyone's machine-specific path being
 * baked into the build.
 */
export function isOmnifexRepo(dir: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    return (JSON.parse(raw) as { name?: unknown }).name === 'omnifex';
  } catch {
    return false;
  }
}

function dirExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export interface ClaudeCliReviewDeps {
  /**
   * Returns the raw `claude --version` output (e.g. "2.1.222 (Claude Code)"),
   * or null when the binary can't be located. Injected so tests never shell
   * out, and so the caller owns binary resolution.
   */
  cliVersionFn: () => string | null;
  /**
   * The user's explicit `cli_review_repo_dir` override, or null/'' when unset.
   * Wins over discovery whenever the directory still exists.
   */
  repoDirOverrideFn?: () => string | null;
  /**
   * Directories to probe when no override is set, in priority order — the dev
   * cwd, then every known project path. Async because the project list is.
   */
  repoCandidatesFn?: () => string[] | Promise<string[]>;
  /** Overridable for tests, which must never touch the real filesystem. */
  dirExistsFn?: (dir: string) => boolean;
  /** Overridable for tests. See `isOmnifexRepo`. */
  isOmnifexRepoFn?: (dir: string) => boolean;
}

/**
 * Pull the dotted-numeric version out of `claude --version` output, which
 * prints the product name alongside it ("2.1.222 (Claude Code)").
 */
export function parseCliVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = /(\d+(?:\.\d+)+)/.exec(raw);
  return match ? match[1] : null;
}

/**
 * Segment-wise numeric comparison. Returns >0 when `a` is newer than `b`.
 * Deliberately not a string compare: '2.1.9' sorts after '2.1.100'
 * lexicographically, which would hide 91 releases' worth of drift.
 */
export function compareCliVersions(a: string, b: string): number {
  const av = a.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const bv = b.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function createClaudeCliReviewService(
  deps: ClaudeCliReviewDeps,
): ClaudeCliReviewService {
  const exists = deps.dirExistsFn ?? dirExists;
  const isRepo = deps.isOmnifexRepoFn ?? isOmnifexRepo;
  // Positive discoveries only. Caching a miss would mean cloning the repo (or
  // opening it as a project for the first time) needs an app restart to be
  // noticed, and the scan is cheap enough that repeating it costs nothing.
  let discovered: string | null = null;

  async function resolveRepoDir(): Promise<string | null> {
    const override = deps.repoDirOverrideFn?.() ?? null;
    // A stale override (folder moved or deleted) falls through to discovery
    // rather than disabling the launch button.
    if (override && exists(override)) return override;
    if (discovered) return discovered;
    let candidates: string[] = [];
    try {
      candidates = (await deps.repoCandidatesFn?.()) ?? [];
    } catch {
      // Project list unavailable — the version half of the payload still ships.
      return null;
    }
    for (const dir of candidates) {
      if (isRepo(dir)) {
        discovered = dir;
        return dir;
      }
    }
    return null;
  }

  async function getStatus(): Promise<CliReviewStatus> {
    // Probed fresh every call, not cached: the user can upgrade the CLI
    // while OmniFex is running, and a value cached at construction would
    // stay stale until the next app restart.
    let raw: string | null = null;
    try {
      raw = deps.cliVersionFn();
    } catch {
      // Binary missing, exec blocked, timeout — all "undeterminable".
      raw = null;
    }
    const installed = parseCliVersion(raw);
    return {
      installed_version: installed,
      reviewed_version: REVIEWED_CLI_VERSION,
      // Strictly-newer only. A user running an OLDER CLI has no unreviewed
      // changelog to show them, and an unknown version must never nag.
      unreviewed: installed !== null && compareCliVersions(installed, REVIEWED_CLI_VERSION) > 0,
      repo_dir: await resolveRepoDir(),
    };
  }

  return { getStatus };
}
