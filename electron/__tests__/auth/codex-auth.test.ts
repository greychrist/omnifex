// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createCodexAuthService,
  type CodexAuthService,
} from '../../services/auth/codex-auth';
import type { OneShotTerminalService } from '../../services/one-shot-terminal';

/**
 * Build a fresh tmpdir that simulates `~/.codex/` so we can write/delete
 * `auth.json` without touching the real user config. fs.mkdtempSync gives a
 * unique dir per test so parallel runs don't collide.
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

/**
 * Minimal mock of OneShotTerminalService — only spawn/kill are used by the
 * auth service. The other methods exist to satisfy the type but are no-ops.
 */
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
      // Point at a non-existent file inside the tmpdir
      authFilePath: path.join(tmp.dir, 'does-not-exist.json'),
      readEnv: () => ({}),
    });

    const status = await service.getStatus();
    expect(status).toEqual({ authenticated: false });
  });

  it('returns apikey mode when OPENAI_API_KEY is set and file is missing', async () => {
    const service = createCodexAuthService({
      oneShotTerminal: makeMockOneShot(),
      authFilePath: path.join(tmp.dir, 'does-not-exist.json'),
      readEnv: () => ({ OPENAI_API_KEY: 'sk-abc123' }),
    });

    const status = await service.getStatus();
    expect(status).toEqual({ authenticated: true, mode: 'apikey' });
  });

  it('returns oauth mode + email when auth file has an email field', async () => {
    fs.writeFileSync(tmp.authFile, JSON.stringify({ email: 'x@y.com', tokens: { id_token: 'abc' } }));
    const service = createCodexAuthService({
      oneShotTerminal: makeMockOneShot(),
      authFilePath: tmp.authFile,
      readEnv: () => ({}),
    });

    const status = await service.getStatus();
    expect(status).toEqual({ authenticated: true, mode: 'oauth', email: 'x@y.com' });
  });

  it('returns oauth mode without email when auth file exists but has no recognized email shape', async () => {
    fs.writeFileSync(tmp.authFile, JSON.stringify({ tokens: { id_token: 'abc' } }));
    const service = createCodexAuthService({
      oneShotTerminal: makeMockOneShot(),
      authFilePath: tmp.authFile,
      readEnv: () => ({}),
    });

    const status = await service.getStatus();
    expect(status).toEqual({ authenticated: true, mode: 'oauth' });
  });

  it('extracts email from account.email nested shape', async () => {
    fs.writeFileSync(tmp.authFile, JSON.stringify({ account: { email: 'nested@y.com' } }));
    const service = createCodexAuthService({
      oneShotTerminal: makeMockOneShot(),
      authFilePath: tmp.authFile,
      readEnv: () => ({}),
    });

    const status = await service.getStatus();
    expect(status).toEqual({ authenticated: true, mode: 'oauth', email: 'nested@y.com' });
  });

  it('falls back to apikey when auth file is unparseable JSON but env key is set', async () => {
    fs.writeFileSync(tmp.authFile, 'not-valid-json{{{');
    const service = createCodexAuthService({
      oneShotTerminal: makeMockOneShot(),
      authFilePath: tmp.authFile,
      readEnv: () => ({ OPENAI_API_KEY: 'sk-fallback' }),
    });

    const status = await service.getStatus();
    expect(status).toEqual({ authenticated: true, mode: 'apikey' });
  });

  it('returns unauthenticated when auth file is unparseable JSON and no env key', async () => {
    fs.writeFileSync(tmp.authFile, 'not-valid-json{{{');
    const service = createCodexAuthService({
      oneShotTerminal: makeMockOneShot(),
      authFilePath: tmp.authFile,
      readEnv: () => ({}),
    });

    const status = await service.getStatus();
    expect(status).toEqual({ authenticated: false });
  });
});

describe('CodexAuthService.watch', () => {
  let tmp: ReturnType<typeof makeTmpCodexDir>;
  let service: CodexAuthService;
  let disposeFns: (() => void)[];

  beforeEach(() => {
    tmp = makeTmpCodexDir();
    disposeFns = [];
  });

  afterEach(() => {
    for (const fn of disposeFns) {
      try { fn(); } catch { /* best-effort */ }
    }
    tmp.cleanup();
  });

  it('fires callback with authenticated=true when the auth file appears', async () => {
    service = createCodexAuthService({
      oneShotTerminal: makeMockOneShot(),
      authFilePath: tmp.authFile,
      readEnv: () => ({}),
    });

    const cb = vi.fn();
    const sub = service.watch(cb);
    disposeFns.push(() => sub.dispose());

    // Give fs.watch a tick to attach before we mutate the directory.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    fs.writeFileSync(tmp.authFile, JSON.stringify({ email: 'x@y.com' }));

    // Wait beyond the ~250ms debounce window for the callback to fire.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    // On flaky CI platforms fs.watch may not fire reliably for a brand-new
    // file. If it didn't fire, the assertion fails loudly — that's the
    // signal to mark .skip per the task spec. As of writing, macOS + Linux
    // hosts fire this reliably.
    expect(cb).toHaveBeenCalled();
    const lastCall = cb.mock.calls[cb.mock.calls.length - 1];
    expect(lastCall[0]).toMatchObject({ authenticated: true, mode: 'oauth' });
  });

  it('dispose() detaches the watcher so further file changes are ignored', async () => {
    service = createCodexAuthService({
      oneShotTerminal: makeMockOneShot(),
      authFilePath: tmp.authFile,
      readEnv: () => ({}),
    });

    const cb = vi.fn();
    const sub = service.watch(cb);
    sub.dispose();

    fs.writeFileSync(tmp.authFile, JSON.stringify({ email: 'x@y.com' }));
    await new Promise<void>((resolve) => setTimeout(resolve, 400));

    expect(cb).not.toHaveBeenCalled();
  });
});

describe('CodexAuthService.startLoginFlow', () => {
  let tmp: ReturnType<typeof makeTmpCodexDir>;

  beforeEach(() => {
    tmp = makeTmpCodexDir();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('throws a clean error when the codex binary cannot be resolved', async () => {
    const service = createCodexAuthService({
      oneShotTerminal: makeMockOneShot(),
      authFilePath: tmp.authFile,
      readEnv: () => ({}),
      resolveCodexBinary: () => null,
    });

    await expect(service.startLoginFlow()).rejects.toThrow(/codex.*not found|codex.*binary/i);
  });

  it('spawns codex login via OneShotTerminal when the binary resolves', async () => {
    const oneShot = makeMockOneShot();
    const service = createCodexAuthService({
      oneShotTerminal: oneShot,
      authFilePath: tmp.authFile,
      readEnv: () => ({}),
      resolveCodexBinary: () => '/fake/codex',
    });

    const result = await service.startLoginFlow();
    expect(result).toEqual({ ptyHandle: 'fake-handle-1' });
    expect(oneShot.__spawn).toHaveBeenCalledTimes(1);
    const [opts] = oneShot.__spawn.mock.calls[0];
    expect(opts).toMatchObject({ binary: '/fake/codex', args: ['login'] });
  });

  it('honours opts.codexBinaryPath over the resolver', async () => {
    const oneShot = makeMockOneShot();
    const service = createCodexAuthService({
      oneShotTerminal: oneShot,
      authFilePath: tmp.authFile,
      readEnv: () => ({}),
      resolveCodexBinary: () => '/system/codex',
    });

    await service.startLoginFlow({ codexBinaryPath: '/explicit/codex' });
    const [opts] = oneShot.__spawn.mock.calls[0];
    expect(opts.binary).toBe('/explicit/codex');
  });
});

describe('CodexAuthService.cancelLoginFlow', () => {
  it('calls kill on the OneShotTerminal handle', () => {
    const oneShot = makeMockOneShot();
    const service = createCodexAuthService({
      oneShotTerminal: oneShot,
      authFilePath: '/nope/auth.json',
      readEnv: () => ({}),
    });

    service.cancelLoginFlow('fake-handle-1');
    expect(oneShot.__kill).toHaveBeenCalledWith('fake-handle-1');
  });
});

describe('CodexAuthService.getBinaryPath', () => {
  it('returns the path from the injected resolver', () => {
    const service = createCodexAuthService({
      oneShotTerminal: makeMockOneShot(),
      authFilePath: '/nope/auth.json',
      readEnv: () => ({}),
      resolveCodexBinary: () => '/fake/codex',
    });
    expect(service.getBinaryPath()).toBe('/fake/codex');
  });

  it('returns null when the resolver returns null', () => {
    const service = createCodexAuthService({
      oneShotTerminal: makeMockOneShot(),
      authFilePath: '/nope/auth.json',
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

    const service = createCodexAuthService({
      oneShotTerminal: makeMockOneShot(),
      authFilePath: tmp.authFile,
      readEnv: () => ({}),
    });

    await service.logout();
    expect(fs.existsSync(tmp.authFile)).toBe(false);
  });

  it('is idempotent when the auth file is already missing', async () => {
    const service = createCodexAuthService({
      oneShotTerminal: makeMockOneShot(),
      authFilePath: path.join(tmp.dir, 'does-not-exist.json'),
      readEnv: () => ({}),
    });

    // Should not throw — already signed out is a valid no-op.
    await expect(service.logout()).resolves.toBeUndefined();
  });
});
