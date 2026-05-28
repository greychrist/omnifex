// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createCodexAuthService,
  type CodexAuthService,
  type CodexAuthStatus,
} from '../../services/auth/codex-auth';
import type { OneShotTerminalService } from '../../services/one-shot-terminal';

/**
 * Build a fresh tmpdir that simulates a Codex `configDir` (CODEX_HOME) so we
 * can write/delete `auth.json` without touching the real user config.
 */
function makeTmpCodexDir(): { dir: string; authFile: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-codex-auth-'));
  const authFile = path.join(dir, 'auth.json');
  return {
    dir,
    authFile,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

function makeMockOneShot(): OneShotTerminalService & {
  __spawn: ReturnType<typeof vi.fn>;
  __kill: ReturnType<typeof vi.fn>;
} {
  const spawn = vi.fn(() => ({ ptyHandle: 'fake-handle-1' }));
  const kill = vi.fn();
  return {
    spawn,
    write: vi.fn(),
    resize: vi.fn(),
    kill,
    onData: vi.fn(() => ({ dispose: () => {} })),
    onExit: vi.fn(() => ({ dispose: () => {} })),
    __spawn: spawn,
    __kill: kill,
  } as unknown as OneShotTerminalService & {
    __spawn: ReturnType<typeof vi.fn>;
    __kill: ReturnType<typeof vi.fn>;
  };
}

describe('CodexAuthService.getStatus', () => {
  let tmp: ReturnType<typeof makeTmpCodexDir>;

  beforeEach(() => {
    tmp = makeTmpCodexDir();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('returns { authenticated: false } when file is missing and no env API key', async () => {
    const service = createCodexAuthService({
      oneShotTerminal: makeMockOneShot(),
      readEnv: () => ({}),
    });

    const status = await service.getStatus(tmp.dir);
    expect(status).toEqual({ authenticated: false });
  });

  it('returns apikey mode when OPENAI_API_KEY is set and file is missing', async () => {
    const service = createCodexAuthService({
      oneShotTerminal: makeMockOneShot(),
      readEnv: () => ({ OPENAI_API_KEY: 'sk-abc123' }),
    });

    const status = await service.getStatus(tmp.dir);
    expect(status).toEqual({ authenticated: true, mode: 'apikey' });
  });

  it('returns oauth mode + email when auth file has an email field', async () => {
    fs.writeFileSync(tmp.authFile, JSON.stringify({ email: 'x@y.com', tokens: { id_token: 'abc' } }));
    const service = createCodexAuthService({ oneShotTerminal: makeMockOneShot(), readEnv: () => ({}) });

    const status = await service.getStatus(tmp.dir);
    expect(status).toEqual({ authenticated: true, mode: 'oauth', email: 'x@y.com' });
  });

  it('returns oauth mode without email when auth file exists but has no recognized email shape', async () => {
    fs.writeFileSync(tmp.authFile, JSON.stringify({ tokens: { id_token: 'abc' } }));
    const service = createCodexAuthService({ oneShotTerminal: makeMockOneShot(), readEnv: () => ({}) });

    const status = await service.getStatus(tmp.dir);
    expect(status).toEqual({ authenticated: true, mode: 'oauth' });
  });

  it('extracts email from account.email nested shape', async () => {
    fs.writeFileSync(tmp.authFile, JSON.stringify({ account: { email: 'nested@y.com' } }));
    const service = createCodexAuthService({ oneShotTerminal: makeMockOneShot(), readEnv: () => ({}) });

    const status = await service.getStatus(tmp.dir);
    expect(status).toEqual({ authenticated: true, mode: 'oauth', email: 'nested@y.com' });
  });

  it('falls back to apikey when auth file is unparseable JSON but env key is set', async () => {
    fs.writeFileSync(tmp.authFile, 'not-valid-json{{{');
    const service = createCodexAuthService({
      oneShotTerminal: makeMockOneShot(),
      readEnv: () => ({ OPENAI_API_KEY: 'sk-fallback' }),
    });

    const status = await service.getStatus(tmp.dir);
    expect(status).toEqual({ authenticated: true, mode: 'apikey' });
  });

  it('returns unauthenticated when auth file is unparseable JSON and no env key', async () => {
    fs.writeFileSync(tmp.authFile, 'not-valid-json{{{');
    const service = createCodexAuthService({ oneShotTerminal: makeMockOneShot(), readEnv: () => ({}) });

    const status = await service.getStatus(tmp.dir);
    expect(status).toEqual({ authenticated: false });
  });

  it('reads each configDir independently', async () => {
    const a = makeTmpCodexDir();
    const b = makeTmpCodexDir();
    fs.writeFileSync(a.authFile, JSON.stringify({ account: { email: 'a@x.com' } }));
    const service = createCodexAuthService({ oneShotTerminal: makeMockOneShot(), readEnv: () => ({}) });

    expect(await service.getStatus(a.dir)).toMatchObject({ authenticated: true, mode: 'oauth', email: 'a@x.com' });
    expect(await service.getStatus(b.dir)).toEqual({ authenticated: false });

    a.cleanup();
    b.cleanup();
  });
});

describe('CodexAuthService.watch', () => {
  let disposeFns: (() => void)[];

  beforeEach(() => {
    disposeFns = [];
  });

  afterEach(() => {
    for (const fn of disposeFns) {
      try { fn(); } catch { /* best-effort */ }
    }
  });

  it('fires callback with authenticated=true when the auth file appears', async () => {
    const tmp = makeTmpCodexDir();
    const service = createCodexAuthService({ oneShotTerminal: makeMockOneShot(), readEnv: () => ({}) });

    const cb = vi.fn();
    const sub = service.watch(tmp.dir, cb);
    disposeFns.push(() => sub.dispose());

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    fs.writeFileSync(tmp.authFile, JSON.stringify({ email: 'x@y.com' }));
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    expect(cb).toHaveBeenCalled();
    const lastCall = cb.mock.calls[cb.mock.calls.length - 1];
    expect(lastCall[0]).toMatchObject({ authenticated: true, mode: 'oauth' });

    tmp.cleanup();
  });

  it('fires per-configDir, isolated from other accounts', async () => {
    const a = makeTmpCodexDir();
    const b = makeTmpCodexDir();
    const service = createCodexAuthService({ oneShotTerminal: makeMockOneShot(), readEnv: () => ({}) });

    const fired: Array<{ dir: 'a' | 'b'; status: CodexAuthStatus }> = [];
    const subA = service.watch(a.dir, (s) => fired.push({ dir: 'a', status: s }));
    const subB = service.watch(b.dir, (s) => fired.push({ dir: 'b', status: s }));
    disposeFns.push(() => subA.dispose(), () => subB.dispose());

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    fs.writeFileSync(a.authFile, JSON.stringify({ account: { email: 'a@x.com' } }));
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    expect(fired.some((f) => f.dir === 'a' && f.status.authenticated)).toBe(true);
    expect(fired.find((f) => f.dir === 'b')).toBeUndefined();

    a.cleanup();
    b.cleanup();
  });

  it('dispose() detaches the watcher so further file changes are ignored', async () => {
    const tmp = makeTmpCodexDir();
    const service = createCodexAuthService({ oneShotTerminal: makeMockOneShot(), readEnv: () => ({}) });

    const cb = vi.fn();
    const sub = service.watch(tmp.dir, cb);
    sub.dispose();

    fs.writeFileSync(tmp.authFile, JSON.stringify({ email: 'x@y.com' }));
    await new Promise<void>((resolve) => setTimeout(resolve, 400));

    expect(cb).not.toHaveBeenCalled();
    tmp.cleanup();
  });
});

describe('CodexAuthService.startLoginFlow', () => {
  it('throws a clean error when the codex binary cannot be resolved', async () => {
    const service = createCodexAuthService({
      oneShotTerminal: makeMockOneShot(),
      readEnv: () => ({}),
      resolveCodexBinary: () => null,
    });

    await expect(service.startLoginFlow({ configDir: '/tmp/.codex' })).rejects.toThrow(/codex.*not found|codex.*binary/i);
  });

  it('spawns codex login via OneShotTerminal with CODEX_HOME set to the configDir', async () => {
    const oneShot = makeMockOneShot();
    const service = createCodexAuthService({
      oneShotTerminal: oneShot,
      readEnv: () => ({ PATH: '/usr/local/bin' }),
      resolveCodexBinary: () => '/fake/codex',
    });

    const result = await service.startLoginFlow({ configDir: '/tmp/my-codex' });
    expect(result).toEqual({ ptyHandle: 'fake-handle-1' });
    expect(oneShot.__spawn).toHaveBeenCalledTimes(1);
    const [opts] = oneShot.__spawn.mock.calls[0];
    expect(opts).toMatchObject({ binary: '/fake/codex', args: ['login'] });
    expect(opts.env).toMatchObject({ CODEX_HOME: '/tmp/my-codex' });
  });

  it('honours opts.codexBinaryPath over the resolver', async () => {
    const oneShot = makeMockOneShot();
    const service = createCodexAuthService({
      oneShotTerminal: oneShot,
      readEnv: () => ({}),
      resolveCodexBinary: () => '/system/codex',
    });

    await service.startLoginFlow({ configDir: '/tmp/.codex', codexBinaryPath: '/explicit/codex' });
    const [opts] = oneShot.__spawn.mock.calls[0];
    expect(opts.binary).toBe('/explicit/codex');
  });
});

describe('CodexAuthService.cancelLoginFlow', () => {
  it('calls kill on the OneShotTerminal handle', () => {
    const oneShot = makeMockOneShot();
    const service = createCodexAuthService({ oneShotTerminal: oneShot, readEnv: () => ({}) });

    service.cancelLoginFlow('fake-handle-1');
    expect(oneShot.__kill).toHaveBeenCalledWith('fake-handle-1');
  });
});

describe('CodexAuthService.getBinaryPath', () => {
  it('returns the path from the injected resolver', () => {
    const service = createCodexAuthService({
      oneShotTerminal: makeMockOneShot(),
      readEnv: () => ({}),
      resolveCodexBinary: () => '/fake/codex',
    });
    expect(service.getBinaryPath()).toBe('/fake/codex');
  });

  it('returns null when the resolver returns null', () => {
    const service = createCodexAuthService({
      oneShotTerminal: makeMockOneShot(),
      readEnv: () => ({}),
      resolveCodexBinary: () => null,
    });
    expect(service.getBinaryPath()).toBeNull();
  });
});

describe('CodexAuthService.logout', () => {
  let tmp: ReturnType<typeof makeTmpCodexDir>;

  beforeEach(() => {
    tmp = makeTmpCodexDir();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('removes the auth file when it exists', async () => {
    fs.writeFileSync(tmp.authFile, JSON.stringify({ email: 'x@y.com' }));
    expect(fs.existsSync(tmp.authFile)).toBe(true);

    const service = createCodexAuthService({ oneShotTerminal: makeMockOneShot(), readEnv: () => ({}) });

    await service.logout(tmp.dir);
    expect(fs.existsSync(tmp.authFile)).toBe(false);
  });

  it('is idempotent when the auth file is already missing', async () => {
    const service = createCodexAuthService({ oneShotTerminal: makeMockOneShot(), readEnv: () => ({}) });

    await expect(service.logout(tmp.dir)).resolves.toBeUndefined();
  });
});
