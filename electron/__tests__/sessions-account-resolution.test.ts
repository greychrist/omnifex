// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

// The SDK is invoked inside start(); stub it so the test doesn't actually
// spawn a Claude subprocess.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => ({
    async *[Symbol.asyncIterator]() { /* never yields */ },
    close: vi.fn(),
  })),
  startup: vi.fn(() => ({
    then(onFulfilled: (warmQuery: unknown) => unknown) {
      return Promise.resolve(onFulfilled({
        query: () => ({
          async *[Symbol.asyncIterator]() { /* never yields */ },
          close: vi.fn(),
        }),
        close: vi.fn(),
      }));
    },
  })),
}));

// Avoid actual binary resolution.
vi.mock('../services/sessions/factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/sessions/factory')>();
  return { ...actual, findSystemClaudeBinary: () => '/usr/local/bin/claude' };
});
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
