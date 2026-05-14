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
 *   • Every leak we've ever had to ~/.claude/ has come from the same shape:
 *     a `configDir` parameter being empty, undefined, the wrong path, or just
 *     literally `~/.claude` — and the spawn site silently passing it through.
 *     Claude Code defaults to `~/.claude` when CLAUDE_CONFIG_DIR is missing or
 *     unreadable, so any empty/wrong value lands there.
 *   • OmniFex never uses `~/.claude` for anything (users have account-scoped
 *     `~/.claude-personal`, `~/.claude-work`, `~/.claude-local`, etc.).
 *     `~/.claude` showing up at a spawn site is unambiguously a bug.
 *   • Spreading `process.env` first preserves `ANTHROPIC_BASE_URL`,
 *     `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_*`, `HTTP_PROXY`, etc. — anything the
 *     user set in their shell environment that we shouldn't drop. The
 *     overrides parameter lets a caller add account-specific extras
 *     (e.g. a future per-account proxy override) without redoing the spread.
 *
 * Throws (loudly, intentionally) on:
 *   - empty / whitespace / non-string `configDir`
 *   - any path that resolves to `<HOMEDIR>/.claude` (the leak we're guarding
 *     against — there is no legitimate reason for an OmniFex spawn to land
 *     there)
 *
 * Does NOT silently fall back to a default account. Falling back at the spawn
 * layer would mask account-resolution bugs upstream — the no-account case
 * needs to be handled at the resolution layer (return null, surface skip
 * code), not papered over here.
 */

const FORBIDDEN_BASENAME = '.claude';

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

  if (resolved === path.join(home, FORBIDDEN_BASENAME)) {
    throw new Error(
      `[claude-env] configDir resolves to ${resolved}, which is the Claude Code default location ` +
        'OmniFex explicitly avoids. Every Claude session must run under an account-scoped ' +
        '(e.g. ~/.claude-personal, ~/.claude-work) config dir.',
    );
  }

  const baseEnv = deps.processEnv ?? process.env;

  // Spread base first; CLAUDE_CONFIG_DIR override second; caller extras last.
  // Caller extras intentionally win — that lets per-account overrides like a
  // custom ANTHROPIC_BASE_URL replace whatever the parent shell carried.
  const result: NodeJS.ProcessEnv = { ...baseEnv, CLAUDE_CONFIG_DIR: resolved };
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
