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
 * Last review: 2.1.234 -> 2.1.235 on 2026-08-19. Findings:
 *
 *  1. Permission dialogs changed twice in this release: display text and the
 *     "don't ask again" option now always describe what a grant would actually
 *     cover, and the option is withheld when the contents can't be fully
 *     displayed (notebook cell delete/replace dialogs previously omitted the
 *     existing cell content silently, and now say why). This is the only 2.1.235
 *     entry that moves a surface OmniFex owns rather than the CLI's own TUI —
 *     we build our own rules and our own "don't ask again" from the
 *     permission-request payload. Absorbed in the permissions change that lands
 *     with this bump (permissions.ts / PermissionCard / permissionRequest.ts);
 *     this watermark is only honest once that lands too.
 *  2. The Agent tool no longer advertises a general-purpose default in sessions
 *     where that agent is unavailable — an omitted `subagent_type` now errors
 *     with the available agents listed. No action: a dispatch that errors
 *     arrives as `tool_result.is_error`, and the reducer already takes
 *     Dispatched -> ToolResult(isError) to a `failed` row rather than leaving a
 *     phantom running one.
 *  3. The context-limit error now says when auto-compact is off and points at
 *     /config. No wire change and nothing to parse — `events.ts` prefers
 *     `errors[0]` generically rather than matching on the text. It does expose a
 *     gap on our side, filed not fixed: `contextPressure.ts` documents an
 *     explicit assumption that "the CLI auto-compacts first", which is what
 *     makes `critical` unreachable on a 200k window and drives the 0.95 clamp.
 *     With auto-compact off that assumption is wrong and the banner tops out
 *     amber while the session walks into a hard limit. The signal is already in
 *     a payload we fetch: `get_context_usage` carries `isAutoCompactEnabled`,
 *     `autoCompactThreshold` and `rawMaxTokens`, none of which we read.
 *     (Noted while there: `CliControlGetContextUsageResponse`'s `total_tokens` /
 *     `remaining_tokens` are vestigial — the live payload is camelCase, and the
 *     renderer reads `totalTokens` / `maxTokens` / `percentage` straight through
 *     the index signature.)
 *  4. SendMessage now refuses messages too large for cross-session delivery up
 *     front instead of dropping them silently. No action: AgentResumed keys on
 *     `toolUseResult.resumedAgentId` (or the same field in the returned JSON),
 *     and a refusal carries neither, so a rejected send can't reopen a
 *     subagent row.
 *
 * Fixed upstream, no action needed: cloud sessions (/ultrareview, /autofix-pr)
 * no longer re-scan and re-render their event streams on every update, and a
 * language server disconnecting mid-session no longer invalidates the whole
 * prompt cache — fewer surprise cache resets behind our cache-expiry glyph.
 *
 * Everything else in 2.1.235 is TUI-local and cannot reach us: the optional
 * spellcheck setting, prompt-input highlight offsets, nested markdown list
 * indentation in the terminal renderer (we render markdown ourselves), the
 * ctrl+t task list starting collapsed on resume (our TaskList owns its own
 * collapse state), Shift+Tab in the permission comment field, slash commands
 * showing HTML entities, the prompt-footer restart notice, vim-mode cursor
 * preservation, dialog arrow-key selection, the embedded grep improvements,
 * the `claude rc` enterprise-gateway check, and the VSCode tab-focus fix.
 */
export const REVIEWED_CLI_VERSION = '2.1.235';

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
