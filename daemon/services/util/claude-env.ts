import os from 'node:os';
import path from 'node:path';
import { REQUEST_REPLAY_ENV } from './request-replay';

/**
 * Throws on an empty, whitespace or non-string configDir: the CLI falls back to `~/.claude` without one.
 * Spreads process.env first so the user's ANTHROPIC_* and proxy vars survive.
 */

export type ClaudeEnvExtras = Record<string, string | undefined>;

export function buildClaudeEnv(
  configDir: string | null | undefined,
  extras: ClaudeEnvExtras = {},
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

  // Caller extras win.
  const result: NodeJS.ProcessEnv = { ...baseEnv, CLAUDE_CONFIG_DIR: resolved };

  // Drop an inherited CLAUDE_CODE_PROJECT_DIR_NAME: it replaces the encoded-cwd transcript dir, which OmniFex derives itself everywhere.
  delete result.CLAUDE_CODE_PROJECT_DIR_NAME;

  // Request replay off unless the user's shell chose; see util/request-replay.ts.
  if (result[REQUEST_REPLAY_ENV] === undefined) result[REQUEST_REPLAY_ENV] = '0';
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

function expandTilde(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}
