// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';

import { createClaudeAuthService } from '../../services/auth/claude-auth';

type Control = (subtype: string, payload: Record<string, unknown> | undefined, opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<unknown>;

const URLS = {
  manualUrl: 'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=ST8',
  automaticUrl: 'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A58100%2Fcallback&state=ST8',
};
const ACCOUNT = { account: { email: 'me@example.com', organization: 'Personal', subscriptionType: 'max' } };

function fakeEngine(control: Control) {
  return {
    start: vi.fn(async (_p: Record<string, unknown>) => {}),
    sendControlRequest: vi.fn(control),
    close: vi.fn(async () => {}),
  };
}

function makeDeps(overrides: Partial<Parameters<typeof createClaudeAuthService>[0]> = {}, control?: Control) {
  const engines: ReturnType<typeof fakeEngine>[] = [];
  const createEngine = vi.fn((_binary: string) => {
    const e = fakeEngine(control ?? (async (subtype) => {
      if (subtype === 'claude_authenticate') return URLS;
      if (subtype === 'claude_oauth_callback' || subtype === 'claude_oauth_wait_for_completion') return ACCOUNT;
      return {};
    }));
    engines.push(e);
    return e;
  });
  const exec = vi.fn(async () => ({ stdout: 'Successfully logged out', stderr: '' }));
  const resolveBinary = vi.fn(() => '/usr/local/bin/claude');
  return {
    // The fake's mocks are looser than SignInEngine's generic signature.
    deps: { createEngine, exec, resolveBinary, ...overrides } as unknown as Parameters<typeof createClaudeAuthService>[0],
    createEngine,
    engines,
    exec,
    resolveBinary,
  };
}

describe('ClaudeAuthService sign-in', () => {
  it('starts a CLI for the account and asks it for the sign-in links', async () => {
    const { deps, engines } = makeDeps();
    const svc = createClaudeAuthService(deps);

    const flow = await svc.beginSignIn('/Users/me/.claude-work');

    expect(flow).toMatchObject({ manualUrl: URLS.manualUrl, automaticUrl: URLS.automaticUrl });
    expect(typeof flow.flowId).toBe('string');
    const start = engines[0].start.mock.calls[0][0];
    expect(start.configDir).toBe('/Users/me/.claude-work');
    expect(start.resume).toBe(false);
    expect(start.projectPath).toBe(os.tmpdir());
    expect(engines[0].sendControlRequest).toHaveBeenCalledWith(
      'claude_authenticate', { loginWithClaudeAi: true }, expect.anything(),
    );
  });

  it('refuses an empty config dir rather than landing on ~/.claude', async () => {
    const { deps, createEngine } = makeDeps();
    await expect(createClaudeAuthService(deps).beginSignIn('  ')).rejects.toThrow(/configDir is empty/);
    expect(createEngine).not.toHaveBeenCalled();
  });

  it('throws a readable error when no claude binary is installed', async () => {
    const { deps } = makeDeps({ resolveBinary: () => null });
    await expect(createClaudeAuthService(deps).beginSignIn('/Users/me/.claude-work')).rejects.toThrow(/claude binary not found/);
  });

  it('closes the CLI when it refuses to start a sign-in', async () => {
    const { deps, engines } = makeDeps({}, async () => { throw new Error('Login method refused by policy'); });
    await expect(createClaudeAuthService(deps).beginSignIn('/d')).rejects.toThrow('Login method refused by policy');
    expect(engines[0].close).toHaveBeenCalled();
  });

  it('finishes with a pasted CODE#STATE and closes the CLI', async () => {
    const { deps, engines } = makeDeps();
    const svc = createClaudeAuthService(deps);
    const { flowId } = await svc.beginSignIn('/d');

    await expect(svc.submitCode(flowId, '  abc123#ST8 \n')).resolves.toEqual({
      email: 'me@example.com', organization: 'Personal', subscriptionType: 'max',
    });
    expect(engines[0].sendControlRequest).toHaveBeenCalledWith(
      'claude_oauth_callback', { authorizationCode: 'abc123', state: 'ST8' }, expect.anything(),
    );
    expect(engines[0].close).toHaveBeenCalled();
  });

  it("takes a bare code, using the flow's own state", async () => {
    const { deps, engines } = makeDeps();
    const svc = createClaudeAuthService(deps);
    const { flowId } = await svc.beginSignIn('/d');
    await svc.submitCode(flowId, 'abc123');
    expect(engines[0].sendControlRequest).toHaveBeenCalledWith(
      'claude_oauth_callback', { authorizationCode: 'abc123', state: 'ST8' }, expect.anything(),
    );
  });

  it('keeps the flow open after a rejected code so it can be pasted again', async () => {
    let calls = 0;
    const { deps, engines } = makeDeps({}, async (subtype) => {
      if (subtype === 'claude_authenticate') return URLS;
      if (subtype === 'claude_oauth_callback' && calls++ === 0) throw new Error('Request failed with status code 400');
      return ACCOUNT;
    });
    const svc = createClaudeAuthService(deps);
    const { flowId } = await svc.beginSignIn('/d');
    await expect(svc.submitCode(flowId, 'bad')).rejects.toThrow(/400/);
    expect(engines[0].close).not.toHaveBeenCalled();
    await expect(svc.submitCode(flowId, 'good#ST8')).resolves.toMatchObject({ email: 'me@example.com' });
  });

  it('waits for the browser to finish on the localhost callback', async () => {
    const { deps, engines } = makeDeps();
    const svc = createClaudeAuthService(deps);
    const { flowId } = await svc.beginSignIn('/d');
    await expect(svc.waitForCompletion(flowId)).resolves.toMatchObject({ email: 'me@example.com' });
    const [, , opts] = engines[0].sendControlRequest.mock.calls.find((c) => c[0] === 'claude_oauth_wait_for_completion')!;
    expect(opts?.timeoutMs).toBeGreaterThanOrEqual(10 * 60_000);
    expect(engines[0].close).toHaveBeenCalled();
  });

  it('cancel aborts a pending wait and closes the CLI', async () => {
    const { deps, engines } = makeDeps({}, (subtype, _p, opts) => {
      if (subtype === 'claude_authenticate') return Promise.resolve(URLS);
      return new Promise((_, reject) => { opts?.signal?.addEventListener('abort', () => { reject(new Error('aborted')); }); });
    });
    const svc = createClaudeAuthService(deps);
    const { flowId } = await svc.beginSignIn('/d');
    const waiting = svc.waitForCompletion(flowId);
    await svc.cancel(flowId);
    await expect(waiting).rejects.toThrow(/cancel/i);
    expect(engines[0].close).toHaveBeenCalled();
  });

  it('a second sign-in for the same account replaces the first', async () => {
    const { deps, engines } = makeDeps();
    const svc = createClaudeAuthService(deps);
    const first = await svc.beginSignIn('/d');
    await svc.beginSignIn('/d');
    expect(engines[0].close).toHaveBeenCalled();
    await expect(svc.submitCode(first.flowId, 'x')).rejects.toThrow(/no sign-in in progress/i);
  });

  it('an unknown flow is a readable error', async () => {
    const { deps } = makeDeps();
    await expect(createClaudeAuthService(deps).waitForCompletion('nope')).rejects.toThrow(/no sign-in in progress/i);
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
