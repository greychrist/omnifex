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
 * Last review: 2.1.233 → 2.1.234 on 2026-08-18. Three findings, all fixed in
 * this pass:
 *
 *  1. 2.1.234 stopped crashing on API responses (non-streaming fallback path,
 *     typically third-party gateways) carrying a thinking block with no
 *     `thinking` field or a text block with no `text` field. Tolerating it
 *     upstream means the shape now reaches our transcript, where every read was
 *     an unguarded `.trim()` against a required-string type — StreamMessage
 *     caught the TypeError itself, so the damage was the whole message
 *     collapsing into its "Error rendering message" card and taking the
 *     assistant's real reply with it, on every reload. `text`/`thinking` are now
 *     optional in `claudeStream.ts` and all 23 reads the compiler found are
 *     guarded.
 *  2. New `CLAUDE_CODE_PROJECT_DIR_NAME` env var. In the binary it is honored
 *     ONLY when CLAUDE_CONFIG_DIR is set (`CGc = memo(() => CLAUDE_CONFIG_DIR ?
 *     validate(EGc()) : undefined)`, consumed as `cF(e) = CGc() ?? aV(e)`), and
 *     OmniFex always sets CLAUDE_CONFIG_DIR — so an inherited value would
 *     redirect every project's transcripts into one flat
 *     `<configDir>/projects/<name>/`, breaking `encodeProjectKey`'s consumers
 *     and making the Brain cross-attribute projects. `buildClaudeEnv` now strips
 *     it. Re-verified while there that our encoder still matches the CLI
 *     exactly: `[^a-zA-Z0-9]` → `-`, cap 200, `-<base36 hash>` suffix.
 *  3. New `autoContinueAtUsageLimit`, default ON for claude.ai logins (the CLI
 *     defaults it off only when an API key is present). A limited session now
 *     parks until the reset instead of ending its turn, so `conversationStatus`
 *     legitimately stays 'running' for hours. Wire shape is unchanged — the
 *     CLI's own predicate reads the same `status: 'rejected'` + `resetsAt` we
 *     already parse — so this needed an explanation, not a state change:
 *     `usageLimitWait` + `UsageLimitBanner`. See docs/session-lifecycle.md.
 *
 * Also fixed upstream, no action needed: `/tui` and the fullscreen-renderer
 * prompt no longer drop launch `--allowed-tools` on restart (we pass the Brain's
 * `--allowedTools` in TUI mode, so a mid-session switch used to start
 * re-prompting for `brain_search`/`brain_read`), and session-scoped permission
 * answers are no longer dropped for background subagent prompts, which is what
 * had been defeating our session-destination rule twin in permissions.ts.
 */
export const REVIEWED_CLI_VERSION = '2.1.234';

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
