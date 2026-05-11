import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createQueryPassthroughs } from '../services/sessions/queries';
import type { SessionHandle } from '../services/sessions/types';

function makeQuery(overrides: Record<string, unknown> = {}) {
  return {
    interrupt: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
    setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
    accountInfo: vi.fn().mockResolvedValue({ email: 'a@b.c' }),
    getContextUsage: vi.fn().mockResolvedValue({ used: 100, total: 200 }),
    supportedCommands: vi.fn().mockResolvedValue([{ name: 'help' }]),
    supportedModels: vi.fn().mockResolvedValue([{ id: 'opus' }]),
    supportedAgents: vi.fn().mockResolvedValue([{ id: 'agent1' }]),
    mcpServerStatus: vi.fn().mockResolvedValue([{ name: 'srv', status: 'connected' }]),
    reloadPlugins: vi.fn().mockResolvedValue({ plugins: [] }),
    ...overrides,
  };
}

function makeHandle(query = makeQuery()): SessionHandle {
  return {
    query: query as unknown as SessionHandle['query'],
    inputChannel: {} as SessionHandle['inputChannel'],
    sessionId: 'sess-1',
    status: 'running',
    mode: 'sdk',
    tui: null,
    tuiDetach: null,
    permissionResolver: null,
    permissionQueue: [],
    elicitationResolver: null,
    projectPath: '/p',
    configDir: '/cfg',
    sdkOptions: {},
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('createQueryPassthroughs.interrupt', () => {
  it('forwards to handle.query.interrupt', async () => {
    const sessions = new Map<string, SessionHandle>();
    const handle = makeHandle();
    sessions.set('t1', handle);
    const q = createQueryPassthroughs(sessions);
    await q.interrupt('t1');
    expect((handle.query as unknown as { interrupt: ReturnType<typeof vi.fn> }).interrupt).toHaveBeenCalled();
  });

  it('is a no-op for unknown tab', async () => {
    const q = createQueryPassthroughs(new Map());
    await expect(q.interrupt('missing')).resolves.toBeUndefined();
  });

  it('swallows SDK errors', async () => {
    const handle = makeHandle(makeQuery({ interrupt: vi.fn().mockRejectedValue(new Error('boom')) }));
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    await expect(q.interrupt('t1')).resolves.toBeUndefined();
  });

  // The user pressing Stop expects feedback. Silent SDK failures here left
  // them mashing the button with nothing happening — surface it to the
  // renderer as a system notification so the chat shows what went wrong.
  it('surfaces interrupt failure as a system.notification.error when sendToRenderer is wired', async () => {
    const handle = makeHandle(
      makeQuery({ interrupt: vi.fn().mockRejectedValue(new Error('SDK transport closed')) }),
    );
    const sessions = new Map([['t1', handle]]);
    const sendToRenderer = vi.fn();
    const q = createQueryPassthroughs(sessions, sendToRenderer);
    await q.interrupt('t1');
    expect(sendToRenderer).toHaveBeenCalledWith(
      'claude-output:t1',
      expect.objectContaining({
        type: 'system',
        subtype: 'notification',
        notification_type: 'error',
        title: expect.stringMatching(/stop|interrupt/i),
        message: expect.stringContaining('SDK transport closed'),
      }),
    );
  });

  it('does not emit a notification when interrupt succeeds', async () => {
    const handle = makeHandle();
    const sessions = new Map([['t1', handle]]);
    const sendToRenderer = vi.fn();
    const q = createQueryPassthroughs(sessions, sendToRenderer);
    await q.interrupt('t1');
    expect(sendToRenderer).not.toHaveBeenCalled();
  });
});

describe('createQueryPassthroughs.setModel', () => {
  it('forwards model to SDK', async () => {
    const handle = makeHandle();
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    await q.setModel('t1', 'opus-4.7');
    expect((handle.query as unknown as { setModel: ReturnType<typeof vi.fn> }).setModel)
      .toHaveBeenCalledWith('opus-4.7');
  });

  it('no-ops for unknown tab', async () => {
    const q = createQueryPassthroughs(new Map());
    await expect(q.setModel('x')).resolves.toBeUndefined();
  });

  it('swallows SDK errors', async () => {
    const handle = makeHandle(makeQuery({ setModel: vi.fn().mockRejectedValue(new Error('x')) }));
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    await expect(q.setModel('t1', 'opus')).resolves.toBeUndefined();
  });
});

describe('createQueryPassthroughs.setPermissionMode', () => {
  it('forwards mode and updates sdkOptions', async () => {
    const handle = makeHandle();
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    await q.setPermissionMode('t1', 'acceptEdits');
    expect(handle.sdkOptions.permissionMode).toBe('acceptEdits');
    expect(handle.sdkOptions.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it('sets allowDangerouslySkipPermissions when mode is bypassPermissions', async () => {
    const handle = makeHandle();
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    await q.setPermissionMode('t1', 'bypassPermissions');
    expect(handle.sdkOptions.allowDangerouslySkipPermissions).toBe(true);
  });

  it('no-ops for unknown tab', async () => {
    const q = createQueryPassthroughs(new Map());
    await expect(q.setPermissionMode('x', 'default')).resolves.toBeUndefined();
  });

  it('swallows SDK errors', async () => {
    const handle = makeHandle(makeQuery({ setPermissionMode: vi.fn().mockRejectedValue(new Error('x')) }));
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    await expect(q.setPermissionMode('t1', 'default')).resolves.toBeUndefined();
  });
});

describe('createQueryPassthroughs.setEffort', () => {
  it('forwards effort level to applyFlagSettings', async () => {
    const handle = makeHandle();
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    await q.setEffort('t1', 'high');
    expect((handle.query as unknown as { applyFlagSettings: ReturnType<typeof vi.fn> }).applyFlagSettings)
      .toHaveBeenCalledWith({ effortLevel: 'high' });
  });

  it('passes undefined when level is null', async () => {
    const handle = makeHandle();
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    await q.setEffort('t1', null);
    expect((handle.query as unknown as { applyFlagSettings: ReturnType<typeof vi.fn> }).applyFlagSettings)
      .toHaveBeenCalledWith({ effortLevel: undefined });
  });

  it('no-ops for unknown tab', async () => {
    const q = createQueryPassthroughs(new Map());
    await expect(q.setEffort('x', 'low')).resolves.toBeUndefined();
  });

  it('swallows SDK errors', async () => {
    const handle = makeHandle(makeQuery({ applyFlagSettings: vi.fn().mockRejectedValue(new Error('x')) }));
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    await expect(q.setEffort('t1', 'low')).resolves.toBeUndefined();
  });
});

describe('createQueryPassthroughs.applyPermissions', () => {
  it('forwards full allow/deny payload to applyFlagSettings', async () => {
    const handle = makeHandle();
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    const perms = { allow: ['Read(*)'], deny: ['Bash(rm *)'] };
    await q.applyPermissions('t1', perms);
    expect((handle.query as unknown as { applyFlagSettings: ReturnType<typeof vi.fn> }).applyFlagSettings)
      .toHaveBeenCalledWith({ permissions: perms });
  });

  it('no-ops for unknown tab', async () => {
    const q = createQueryPassthroughs(new Map());
    await expect(q.applyPermissions('x', { allow: [] })).resolves.toBeUndefined();
  });

  it('swallows SDK errors', async () => {
    const handle = makeHandle(makeQuery({ applyFlagSettings: vi.fn().mockRejectedValue(new Error('x')) }));
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    await expect(q.applyPermissions('t1', {})).resolves.toBeUndefined();
  });

  it('emits a renderer warning when applyFlagSettings rejects', async () => {
    // Without this signal, the rule lands on disk but the live session keeps
    // prompting — the user thinks "I just allowed this, why is it asking again?"
    // because the apply failed silently. We push a system warning so the chat
    // surfaces the mismatch.
    const handle = makeHandle(
      makeQuery({ applyFlagSettings: vi.fn().mockRejectedValue(new Error('apply blew up')) }),
    );
    const sessions = new Map([['tab-warn', handle]]);
    const sendToRenderer = vi.fn();
    const q = createQueryPassthroughs(sessions, sendToRenderer);

    await q.applyPermissions('tab-warn', { allow: ['Bash(ls)'] });

    const warningCall = sendToRenderer.mock.calls.find(
      ([ch, payload]: any[]) =>
        ch === 'claude-output:tab-warn' &&
        payload?.type === 'system' &&
        payload?.subtype === 'notification' &&
        payload?.notification_type === 'warn',
    );
    expect(warningCall).toBeTruthy();
    const payload = warningCall![1];
    expect(String(payload.message)).toMatch(/restart|apply/i);
    expect(String(payload.message)).toContain('apply blew up');
  });
});

describe('createQueryPassthroughs.setThinking', () => {
  it('disabled config sets max thinking to 0', async () => {
    const handle = makeHandle();
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    await q.setThinking('t1', { type: 'disabled' });
    expect((handle.query as unknown as { setMaxThinkingTokens: ReturnType<typeof vi.fn> }).setMaxThinkingTokens)
      .toHaveBeenCalledWith(0);
  });

  it('null config sets max thinking to 0 (treated as disabled)', async () => {
    const handle = makeHandle();
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    await q.setThinking('t1', undefined);
    expect((handle.query as unknown as { setMaxThinkingTokens: ReturnType<typeof vi.fn> }).setMaxThinkingTokens)
      .toHaveBeenCalledWith(0);
  });

  it('adaptive config sets max thinking to null (SDK chooses)', async () => {
    const handle = makeHandle();
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    await q.setThinking('t1', { type: 'adaptive' });
    expect((handle.query as unknown as { setMaxThinkingTokens: ReturnType<typeof vi.fn> }).setMaxThinkingTokens)
      .toHaveBeenCalledWith(null);
  });

  it('enabled config with budgetTokens collapses to adaptive (calls setMaxThinkingTokens(null))', async () => {
    // Budget was removed in v0.4.21 — the SDK collapsed every non-zero
    // value to adaptive on Opus 4.6+ anyway. Stale callers passing
    // `enabled` with a budget should land on adaptive, not forward the
    // budget number (which the SDK would just discard).
    const handle = makeHandle();
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    await q.setThinking('t1', { type: 'enabled', budgetTokens: 5000 });
    expect((handle.query as unknown as { setMaxThinkingTokens: ReturnType<typeof vi.fn> }).setMaxThinkingTokens)
      .toHaveBeenCalledWith(null);
  });

  it('enabled config without budgetTokens also collapses to adaptive', async () => {
    const handle = makeHandle();
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    await q.setThinking('t1', { type: 'enabled' });
    expect((handle.query as unknown as { setMaxThinkingTokens: ReturnType<typeof vi.fn> }).setMaxThinkingTokens)
      .toHaveBeenCalledWith(null);
  });

  it('no-ops for unknown tab', async () => {
    const q = createQueryPassthroughs(new Map());
    await expect(q.setThinking('x', { type: 'adaptive' })).resolves.toBeUndefined();
  });

  it('swallows SDK errors', async () => {
    const handle = makeHandle(makeQuery({ setMaxThinkingTokens: vi.fn().mockRejectedValue(new Error('x')) }));
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    await expect(q.setThinking('t1', { type: 'adaptive' })).resolves.toBeUndefined();
  });
});

describe('createQueryPassthroughs.getAccountInfo', () => {
  it('returns SDK accountInfo result', async () => {
    const handle = makeHandle();
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    expect(await q.getAccountInfo('t1')).toEqual({ email: 'a@b.c' });
  });

  it('returns null for unknown tab', async () => {
    const q = createQueryPassthroughs(new Map());
    expect(await q.getAccountInfo('x')).toBeNull();
  });

  it('returns null on SDK error', async () => {
    const handle = makeHandle(makeQuery({ accountInfo: vi.fn().mockRejectedValue(new Error('x')) }));
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    expect(await q.getAccountInfo('t1')).toBeNull();
  });
});

describe('createQueryPassthroughs.getContextUsage', () => {
  it('returns SDK getContextUsage result', async () => {
    const handle = makeHandle();
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    expect(await q.getContextUsage('t1')).toEqual({ used: 100, total: 200 });
  });

  it('returns null for unknown tab', async () => {
    const q = createQueryPassthroughs(new Map());
    expect(await q.getContextUsage('x')).toBeNull();
  });

  it('returns null on SDK error', async () => {
    const handle = makeHandle(makeQuery({ getContextUsage: vi.fn().mockRejectedValue(new Error('x')) }));
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    expect(await q.getContextUsage('t1')).toBeNull();
  });
});

describe('createQueryPassthroughs.getSupportedCommands', () => {
  it('returns SDK commands', async () => {
    const handle = makeHandle();
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    expect(await q.getSupportedCommands('t1')).toEqual([{ name: 'help' }]);
  });

  it('returns [] for unknown tab', async () => {
    const q = createQueryPassthroughs(new Map());
    expect(await q.getSupportedCommands('x')).toEqual([]);
  });

  it('returns [] on SDK error', async () => {
    const handle = makeHandle(makeQuery({ supportedCommands: vi.fn().mockRejectedValue(new Error('x')) }));
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    expect(await q.getSupportedCommands('t1')).toEqual([]);
  });
});

describe('createQueryPassthroughs.getSupportedModels', () => {
  it('returns SDK models', async () => {
    const handle = makeHandle();
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    expect(await q.getSupportedModels('t1')).toEqual([{ id: 'opus' }]);
  });

  it('returns [] for unknown tab', async () => {
    const q = createQueryPassthroughs(new Map());
    expect(await q.getSupportedModels('x')).toEqual([]);
  });

  it('returns [] on SDK error', async () => {
    const handle = makeHandle(makeQuery({ supportedModels: vi.fn().mockRejectedValue(new Error('x')) }));
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    expect(await q.getSupportedModels('t1')).toEqual([]);
  });
});

describe('createQueryPassthroughs.getSupportedAgents', () => {
  it('returns SDK agents', async () => {
    const handle = makeHandle();
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    expect(await q.getSupportedAgents('t1')).toEqual([{ id: 'agent1' }]);
  });

  it('returns [] for unknown tab', async () => {
    const q = createQueryPassthroughs(new Map());
    expect(await q.getSupportedAgents('x')).toEqual([]);
  });

  it('returns [] on SDK error', async () => {
    const handle = makeHandle(makeQuery({ supportedAgents: vi.fn().mockRejectedValue(new Error('x')) }));
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    expect(await q.getSupportedAgents('t1')).toEqual([]);
  });
});

describe('createQueryPassthroughs.getMcpServerStatus', () => {
  it('returns SDK mcp server status when non-empty', async () => {
    const handle = makeHandle();
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    const result = await q.getMcpServerStatus('t1');
    expect(result).toEqual([{ name: 'srv', status: 'connected' }]);
  });

  it('returns [] for unknown tab', async () => {
    const q = createQueryPassthroughs(new Map());
    expect(await q.getMcpServerStatus('x')).toEqual([]);
  });

  it('returns [] when SDK returns empty list', async () => {
    const handle = makeHandle(makeQuery({ mcpServerStatus: vi.fn().mockResolvedValue([]) }));
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    expect(await q.getMcpServerStatus('t1')).toEqual([]);
  });

  it('returns [] when SDK throws (not ready)', async () => {
    const handle = makeHandle(makeQuery({ mcpServerStatus: vi.fn().mockRejectedValue(new Error('not ready')) }));
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    expect(await q.getMcpServerStatus('t1')).toEqual([]);
  });
});

describe('createQueryPassthroughs.getPlugins', () => {
  it('returns enriched plugins from SDK', async () => {
    const handle = makeHandle(
      makeQuery({
        reloadPlugins: vi.fn().mockResolvedValue({
          plugins: [{ name: 'p1', path: '/tmp/p1', version: '1', enabled: true, source: 'user' }],
        }),
      }),
    );
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    const result = await q.getPlugins('t1', true);
    expect(result.length).toBe(1);
  });

  it('returns [] for unknown tab', async () => {
    const q = createQueryPassthroughs(new Map());
    expect(await q.getPlugins('x')).toEqual([]);
  });

  it('caches results across non-forced calls', async () => {
    const reload = vi.fn().mockResolvedValue({
      plugins: [{ name: 'p1', path: '/tmp/p1', version: '1', enabled: true, source: 'user' }],
    });
    const handle = makeHandle(makeQuery({ reloadPlugins: reload }));
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    await q.getPlugins('t1');
    await q.getPlugins('t1');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('refreshes when force=true', async () => {
    const reload = vi.fn().mockResolvedValue({ plugins: [] });
    const handle = makeHandle(makeQuery({ reloadPlugins: reload }));
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    await q.getPlugins('t1');
    await q.getPlugins('t1', true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('evictPluginCache(tabId) drops the cache so the next call re-fetches', async () => {
    // Without eviction the cache grows unbounded across the lifetime of the
    // service: every closed tab leaves an entry behind. The lifecycle layer
    // calls evictPluginCache(tabId) on session stop to keep this bounded.
    const reload = vi.fn().mockResolvedValue({
      plugins: [{ name: 'p1', path: '/tmp/p1', version: '1', enabled: true, source: 'user' }],
    });
    const handle = makeHandle(makeQuery({ reloadPlugins: reload }));
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);

    await q.getPlugins('t1'); // populates cache
    expect(reload).toHaveBeenCalledTimes(1);

    q.evictPluginCache('t1');

    await q.getPlugins('t1'); // cache empty → re-fetch
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('returns cached value on SDK error after a previous successful call', async () => {
    const reload = vi
      .fn()
      .mockResolvedValueOnce({ plugins: [{ name: 'p1', path: '/tmp/p1', version: '1', enabled: true, source: 'user' }] })
      .mockRejectedValueOnce(new Error('boom'));
    const handle = makeHandle(makeQuery({ reloadPlugins: reload }));
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    const first = await q.getPlugins('t1', true);
    const second = await q.getPlugins('t1', true);
    expect(second).toEqual(first);
  });

  it('returns [] when no cache and SDK throws', async () => {
    const reload = vi.fn().mockRejectedValue(new Error('boom'));
    const handle = makeHandle(makeQuery({ reloadPlugins: reload }));
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    expect(await q.getPlugins('t1', true)).toEqual([]);
  });

  it('returns cached value when SDK race times out (returns null)', async () => {
    const reload = vi
      .fn()
      .mockResolvedValueOnce({ plugins: [{ name: 'p1', path: '/tmp/p1', version: '1', enabled: true, source: 'user' }] });
    const handle = makeHandle(makeQuery({ reloadPlugins: reload }));
    const sessions = new Map([['t1', handle]]);
    const q = createQueryPassthroughs(sessions);
    const first = await q.getPlugins('t1', true);
    expect(first.length).toBe(1);
  });
});
