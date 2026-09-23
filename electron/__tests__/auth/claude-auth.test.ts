// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';

import { createClaudeAuthService } from '../../services/auth/claude-auth';

function makeDeps(overrides: Partial<Parameters<typeof createClaudeAuthService>[0]> = {}) {
  const spawnTerminal = vi.fn(() => ({ ptyHandle: 'pty-1' }));
  const exec = vi.fn(async () => ({ stdout: 'Successfully logged out', stderr: '' }));
  const resolveBinary = vi.fn(() => '/usr/local/bin/claude');
  return {
    deps: { spawnTerminal, exec, resolveBinary, ...overrides },
    spawnTerminal,
    exec,
    resolveBinary,
  };
}

describe('ClaudeAuthService.startLoginFlow', () => {
  it('spawns `claude auth login` in a pty scoped to the account config dir', () => {
    const { deps, spawnTerminal } = makeDeps();
    const svc = createClaudeAuthService(deps);

    const handle = svc.startLoginFlow('/Users/me/.claude-work', { cols: 100, rows: 30 });

    expect(handle).toEqual({ ptyHandle: 'pty-1' });
    expect(spawnTerminal).toHaveBeenCalledTimes(1);
    const opts = (spawnTerminal.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(opts.binary).toBe('/usr/local/bin/claude');
    expect(opts.args).toEqual(['auth', 'login']);
    expect(opts.cwd).toBe(os.homedir());
    expect(opts.cols).toBe(100);
    expect(opts.rows).toBe(30);
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe('/Users/me/.claude-work');
    // Inherits the parent env — a bare `{ CLAUDE_CONFIG_DIR }` would drop
    // HOME/PATH, and the CLI cannot reach the Keychain without them.
    expect(opts.env.PATH).toBe(process.env.PATH);
  });

  it('refuses an empty config dir rather than landing on ~/.claude', () => {
    const { deps, spawnTerminal } = makeDeps();
    const svc = createClaudeAuthService(deps);
    expect(() => svc.startLoginFlow('  ')).toThrow(/configDir is empty/);
    expect(spawnTerminal).not.toHaveBeenCalled();
  });

  it('throws a readable error when no claude binary is installed', () => {
    const { deps } = makeDeps({ resolveBinary: () => null });
    const svc = createClaudeAuthService(deps);
    expect(() => svc.startLoginFlow('/Users/me/.claude-work')).toThrow(/claude binary not found/);
  });
});

describe('ClaudeAuthService.logout', () => {
  it('runs `claude auth logout` against the account config dir', async () => {
    const { deps, exec } = makeDeps();
    const svc = createClaudeAuthService(deps);

    await svc.logout('/Users/me/.claude-personal');

    expect(exec).toHaveBeenCalledTimes(1);
    const [bin, args, env] = exec.mock.calls[0] as unknown as [string, string[], NodeJS.ProcessEnv];
    expect(bin).toBe('/usr/local/bin/claude');
    expect(args).toEqual(['auth', 'logout']);
    expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/me/.claude-personal');
  });

  it('surfaces the CLI stderr when logout fails', async () => {
    const failure = Object.assign(new Error('Command failed'), { stderr: 'keychain locked\n' });
    const { deps } = makeDeps({ exec: vi.fn(async () => { throw failure; }) });
    const svc = createClaudeAuthService(deps);
    await expect(svc.logout('/Users/me/.claude-work')).rejects.toThrow('keychain locked');
  });

  it('refuses an empty config dir', async () => {
    const { deps, exec } = makeDeps();
    const svc = createClaudeAuthService(deps);
    await expect(svc.logout('')).rejects.toThrow(/configDir is empty/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('throws a readable error when no claude binary is installed', async () => {
    const { deps } = makeDeps({ resolveBinary: () => null });
    const svc = createClaudeAuthService(deps);
    await expect(svc.logout('/Users/me/.claude-work')).rejects.toThrow(/claude binary not found/);
  });
});
