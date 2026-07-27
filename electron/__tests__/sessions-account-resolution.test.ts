// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

// Stub the engine so start() doesn't actually spawn a Claude subprocess.
vi.mock('../services/agents/claude-cli-engine', () => ({
  createClaudeCliEngine: vi.fn(() => ({
    kind: 'claude',
    applyExtendedPermissionMode: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    sendStructured: vi.fn(async () => {}),
    sendControlRequest: vi.fn(async () => undefined),
    respondPermission: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    kill: vi.fn(),
    getResumeId: vi.fn(() => null),
    getInitData: vi.fn(() => null),
    onMessage: vi.fn(() => ({ dispose() {} })),
    onPermissionRequest: vi.fn(() => ({ dispose() {} })),
    onError: vi.fn(() => ({ dispose() {} })),
    onExit: vi.fn(() => ({ dispose() {} })),
  })),
}));

// Avoid actual binary resolution.
vi.mock('../services/sessions/binary', () => ({
  findSystemClaudeBinary: vi.fn(() => '/usr/local/bin/claude'),
}));

import { createSessionsService } from '../services/sessions';

describe('sessions.start — account re-resolution', () => {
  const baseParams = {
    tabId: 'tab-rr',
    projectPath: '/Users/test/proj',
    model: '',
    permissionMode: '',
  } as const;

  it('cold-start re-resolves configDir via the injected resolver (renderer-supplied configDir is treated as stale)', () => {
    const resolveAccountConfigDir = vi.fn(() => '/fresh-config-from-resolver');
    const sessions = createSessionsService(
      vi.fn(),     // sendToRenderer
      undefined,   // notificationHooks
      null,        // logging
      null,        // ownership
      null,        // persistPermissionRule
      null,        // rateLimitHook
      null,        // onSessionClosed
      resolveAccountConfigDir,
    );

    sessions.start({
      ...baseParams,
      configDir: '/stale-config-from-renderer',
    });

    expect(resolveAccountConfigDir).toHaveBeenCalledWith('/Users/test/proj');
    expect(sessions.getConfigDir('tab-rr')).toBe('/fresh-config-from-resolver');
  });

  it('cold-start with manualAccountOverride=true trusts the renderer-supplied configDir', () => {
    const resolveAccountConfigDir = vi.fn(() => '/would-be-resolved');
    const sessions = createSessionsService(
      vi.fn(), undefined, null, null, null, null, null,
      resolveAccountConfigDir,
    );

    sessions.start({
      ...baseParams,
      configDir: '/explicit-user-choice',
      manualAccountOverride: true,
    });

    expect(resolveAccountConfigDir).not.toHaveBeenCalled();
    expect(sessions.getConfigDir('tab-rr')).toBe('/explicit-user-choice');
  });

  it('resume (resumeSessionId present) trusts the renderer-supplied configDir even without manualAccountOverride', () => {
    // The original session's JSONL lives under that account's configDir.
    // Re-resolving could route us to a different account and orphan the
    // saved transcript.
    const resolveAccountConfigDir = vi.fn(() => '/different-account');
    const sessions = createSessionsService(
      vi.fn(), undefined, null, null, null, null, null,
      resolveAccountConfigDir,
    );

    sessions.start({
      ...baseParams,
      configDir: '/owning-account',
      resumeSessionId: '11111111-2222-3333-4444-555555555555',
    });

    expect(resolveAccountConfigDir).not.toHaveBeenCalled();
    expect(sessions.getConfigDir('tab-rr')).toBe('/owning-account');
  });

  it('falls back to params.configDir when no resolver is injected (back-compat)', () => {
    const sessions = createSessionsService(vi.fn());
    sessions.start({
      ...baseParams,
      configDir: '/from-renderer',
    });
    expect(sessions.getConfigDir('tab-rr')).toBe('/from-renderer');
  });
});

// ---------------------------------------------------------------------------
// Secondary confirmation: is the resolved config dir actually authenticated as
// the account we think it is? Never blocks — the session starts either way.
// ---------------------------------------------------------------------------

describe('sessions.start — account identity verification', () => {
  const baseParams = {
    tabId: 'tab-v',
    projectPath: '/Users/test/proj',
    model: '',
    permissionMode: '',
  } as const;

  function makeService(
    sendToRenderer: (channel: string, ...args: unknown[]) => void,
    verify: ((configDir: string) => unknown) | null,
    resolveAccountConfigDir: ((projectPath: string) => string | null) | null = null,
  ) {
    return createSessionsService(
      sendToRenderer,
      undefined,               // notificationHooks
      null,                    // logging
      null,                    // ownership
      null,                    // persistPermissionRule
      null,                    // rateLimitHook
      null,                    // onSessionClosed
      resolveAccountConfigDir, // resolveAccountConfigDir
      null,                    // modelCatalogSink
      verify as never,         // verifyAccountIdentity
    );
  }

  it('emits session-account-mismatch and STILL starts the session', () => {
    const sent: Array<[string, unknown]> = [];
    const verify = vi.fn(() => ({
      expected: 'work@example.com',
      detected: 'personal@example.com',
      configDir: '/tmp/.claude-personal',
      source: 'oauth-file' as const,
    }));

    const sessions = makeService(
      (ch, ...args) => { sent.push([ch, args[0]]); },
      verify,
    );

    sessions.start({ ...baseParams, configDir: '/tmp/.claude-personal' });

    expect(sent.find(([ch]) => ch === 'session-account-mismatch:tab-v')?.[1]).toEqual({
      expected: 'work@example.com',
      detected: 'personal@example.com',
      configDir: '/tmp/.claude-personal',
      source: 'oauth-file',
    });
    // The warning is informational — it must not gate the launch.
    expect(sessions.getConfigDir('tab-v')).toBe('/tmp/.claude-personal');
  });

  it('emits nothing when the verifier reports a match', () => {
    const sent: string[] = [];
    const sessions = makeService((ch) => { sent.push(ch); }, () => null);

    sessions.start({ ...baseParams, configDir: '/tmp/.claude-personal' });

    expect(sent.some((ch) => ch.startsWith('session-account-mismatch:'))).toBe(false);
  });

  it('does no verification work at all when no verifier is injected', () => {
    const sent: string[] = [];
    const sessions = createSessionsService((ch: string) => { sent.push(ch); });

    sessions.start({ ...baseParams, configDir: '/tmp/.claude-personal' });

    expect(sent.some((ch) => ch.startsWith('session-account-mismatch:'))).toBe(false);
  });

  it('verifies against the RE-RESOLVED configDir, not the one the renderer sent', () => {
    const seen: string[] = [];
    const sessions = makeService(
      vi.fn(),
      (dir: string) => { seen.push(dir); return null; },
      () => '/tmp/.claude-work',
    );

    sessions.start({ ...baseParams, configDir: '/tmp/.claude-personal' });

    // Checking the renderer-supplied dir would verify the wrong account
    // exactly when a path rule has just changed.
    expect(seen).toEqual(['/tmp/.claude-work']);
  });

  it('a throwing verifier does not break the launch', () => {
    const sent: string[] = [];
    const sessions = makeService(
      (ch) => { sent.push(ch); },
      () => { throw new Error('boom'); },
    );

    expect(() => {
      sessions.start({ ...baseParams, configDir: '/tmp/.claude-personal' });
    }).not.toThrow();
    expect(sessions.getConfigDir('tab-v')).toBe('/tmp/.claude-personal');
  });
});
