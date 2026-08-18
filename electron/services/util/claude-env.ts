import os from 'node:os';
import path from 'node:path';

/**
 * Single source of truth for the env passed to every Claude Code subprocess
 * spawned by OmniFex (interactive sessions, TUI mode, session-summary one-shot,
 * usage runner, model picker, CLI usage probe, …).
 *
 * Why this needs to be one helper rather than five copies of
 * `{ ...process.env, CLAUDE_CONFIG_DIR: configDir }`:
 *
 *   • The only leak shape that actually matters is `configDir` arriving empty,
 *     whitespace, or non-string — Claude Code falls back to `~/.claude` when
 *     CLAUDE_CONFIG_DIR is missing or unreadable, so any such value silently
 *     hijacks the user's default config. We throw on those inputs to surface
 *     account-resolution bugs at the spawn site instead of corrupting state.
 *   • `~/.claude` itself is a legitimate destination: single-account users
 *     who never created `.claude-personal` / `.claude-work` configure an
 *     account pointing at the stock dir, and that needs to work. The "don't
 *     silently default to it" property is enforced at the resolution layer
 *     (accounts.resolve() returns null when no override/path-rule matches),
 *     not here — by the time a configDir reaches this function it was already
 *     picked deliberately.
 *   • Spreading `process.env` first preserves `ANTHROPIC_BASE_URL`,
 *     `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_*`, `HTTP_PROXY`, etc. — anything the
 *     user set in their shell environment that we shouldn't drop. The
 *     overrides parameter lets a caller add account-specific extras
 *     (e.g. a future per-account proxy override) without redoing the spread.
 *
 * Throws (loudly, intentionally) on empty / whitespace / non-string
 * `configDir`. Does NOT silently fall back to a default account — the
 * no-account case is handled at the resolution layer (return null, surface
 * skip code), not papered over here.
 */

export type ClaudeEnvExtras = Record<string, string | undefined>;

export function buildClaudeEnv(
  configDir: string | null | undefined,
  extras: ClaudeEnvExtras = {},
  // process.env + homedir are injected so this stays testable without
  // monkey-patching globals.
  deps: { processEnv?: NodeJS.ProcessEnv; homedir?: () => string } = {},
): NodeJS.ProcessEnv {
  if (typeof configDir !== 'string') {
    throw new Error(
      `[claude-env] configDir must be a string (got ${typeof configDir}); refusing to spawn`,
    );
  }
  const trimmed = configDir.trim();
  if (!trimmed) {
    throw new Error(
      '[claude-env] configDir is empty; refusing to spawn (would land on ~/.claude)',
    );
  }

  const homedirFn = deps.homedir ?? os.homedir;
  const home = homedirFn();
  const expanded = expandTilde(trimmed, home);
  const resolved = path.resolve(expanded);

  const baseEnv = deps.processEnv ?? process.env;

  // Spread base first; CLAUDE_CONFIG_DIR override second; caller extras last.
  // Caller extras intentionally win — that lets per-account overrides like a
  // custom ANTHROPIC_BASE_URL replace whatever the parent shell carried.
  const result: NodeJS.ProcessEnv = { ...baseEnv, CLAUDE_CONFIG_DIR: resolved };

  // Drop an inherited CLAUDE_CODE_PROJECT_DIR_NAME (Claude Code 2.1.234). The
  // CLI honors it only when CLAUDE_CONFIG_DIR is set — which is exactly what
  // we just did — and it replaces the encoded-cwd transcript directory
  // wholesale: `projectDir = CLAUDE_CODE_PROJECT_DIR_NAME ?? encodedCwd(path)`.
  // OmniFex derives that same directory itself (`encodeProjectKey` in
  // sessions/summary-query.ts) for JSONL tailing, cost history, the
  // summary-scratch sweep and the Brain's transcript source, so a value
  // arriving from the parent shell would point every one of those at the wrong
  // place AND collapse every project into one directory, which the Brain reads
  // as project identity. We own the derivation, so we own the variable.
  delete result.CLAUDE_CODE_PROJECT_DIR_NAME;
  for (const [k, v] of Object.entries(extras)) {
    if (v === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- justified: env-var removal API; key is bounded by Object.entries(extras).
      delete result[k];
    } else {
      result[k] = v;
    }
  }
  return result;
}

/**
 * Expand a leading `~` or `~/` to the home directory. We don't try to handle
 * `~user` (other-user expansion) — only the current user's home, which is the
 * only form CLAUDE_CONFIG_DIR ever takes in practice.
 */
function expandTilde(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}
