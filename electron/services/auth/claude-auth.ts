/**
 * ClaudeAuthService — sign a Claude account in or out from inside OmniFex.
 *
 * Both operations drive the CLI's own `claude auth` subcommands rather than
 * touching credentials directly. On macOS the OAuth tokens live in the
 * Keychain, not under the config dir, so deleting files would leave the
 * account signed in; the CLI is the only thing that knows where its secrets
 * are. `claude auth logout` also drops `oauthAccount` from `.claude.json`
 * (verified on 2.1.280), which is what `watchOauthIdentity` keys on — so the
 * verification badges update through the existing watcher, with no extra
 * broadcast from here.
 *
 * Every spawn goes through `buildClaudeEnv`, which inherits the parent env
 * (HOME/PATH are needed to reach the Keychain) and refuses an empty
 * `configDir` rather than letting the CLI fall back to `~/.claude`.
 */

import os from 'node:os';
import { execFile } from 'node:child_process';
import { buildClaudeEnv } from '../util/claude-env';

export interface ClaudeAuthService {
  /** Spawn `claude auth login` in a one-shot pty for this account. */
  startLoginFlow(configDir: string, size?: { cols?: number; rows?: number }): { ptyHandle: string };
  /** Run `claude auth logout` for this account. Rejects with the CLI's stderr. */
  logout(configDir: string): Promise<void>;
}

export interface CreateClaudeAuthServiceDeps {
  /** Main's one-shot terminal adapter — spawns and wires data/exit forwarding. */
  spawnTerminal(opts: {
    binary: string;
    args: string[];
    env: Record<string, string | undefined>;
    cwd: string;
    cols?: number;
    rows?: number;
  }): { ptyHandle: string };
  resolveBinary(): string | null;
  /** Injectable for tests. Defaults to execFile with a 30s timeout. */
  exec?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>;
}

function defaultExec(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, timeout: 30_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

export function createClaudeAuthService(deps: CreateClaudeAuthServiceDeps): ClaudeAuthService {
  const exec = deps.exec ?? defaultExec;

  function requireBinary(): string {
    const bin = deps.resolveBinary();
    if (!bin) throw new Error('claude binary not found. Install Claude Code or set its path in OmniFex settings.');
    return bin;
  }

  return {
    startLoginFlow(configDir, size = {}) {
      const env = buildClaudeEnv(configDir);
      return deps.spawnTerminal({
        binary: requireBinary(),
        args: ['auth', 'login'],
        env,
        cwd: os.homedir(),
        cols: size.cols,
        rows: size.rows,
      });
    },

    async logout(configDir) {
      const env = buildClaudeEnv(configDir);
      const bin = requireBinary();
      try {
        await exec(bin, ['auth', 'logout'], env);
      } catch (err) {
        const stderr = (err as { stderr?: unknown }).stderr;
        const detail = typeof stderr === 'string' && stderr.trim() ? stderr.trim() : (err as Error).message;
        throw new Error(`claude auth logout failed: ${detail}`);
      }
    },
  };
}
