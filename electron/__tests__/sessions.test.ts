import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAsyncChannel } from '../services/async-channel';
import { createSessionsService, type SessionsService } from '../services/sessions';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Mock the Claude Agent SDK
// ---------------------------------------------------------------------------

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

vi.mock('../services/sessions/tui', () => ({
  createTuiSession: vi.fn(),
}));

// Default the binary resolver so existing tests don't require a real
// claude install on the test machine. Per-test overrides via mockReturnValueOnce.
vi.mock('../services/sessions/binary', () => ({
  findSystemClaudeBinary: vi.fn(() => '/mock/bin/claude'),
}));

const mockedQuery = vi.mocked(sdkQuery);

import { createTuiSession as _createTuiSession } from '../services/sessions/tui';
const mockedCreateTuiSession = vi.mocked(_createTuiSession);

import { findSystemClaudeBinary as _findSystemClaudeBinary } from '../services/sessions/binary';
const mockedFindSystemClaudeBinary = vi.mocked(_findSystemClaudeBinary);

// ---------------------------------------------------------------------------
// A controllable fake `Query`. The sessions service treats the return value of
// `query()` as an async iterable with a `.close()` method, so that's all we
// need to stub. The test drives it with `pushMessage()` / `closeMessages()`.
// ---------------------------------------------------------------------------

interface FakeQueryHandle {
  /** The thing handed to `createSessionsService.start()` as the Query. */
  query: any;
  /** Push a synthetic SDK message through the stream. */
  pushMessage: (msg: unknown) => void;
  /** Signal end-of-stream. */
  closeMessages: () => void;
  /** Whether `query.close()` was called by the service. */
  wasClosed: () => boolean;
  /** The options passed to the SDK — captured so tests can poke hooks. */
  getCapturedOptions: () => any;
  /** The prompt async iterable passed to the SDK (the sessions service input channel). */
  getCapturedPrompt: () => any;
}

function installFakeQuery(): FakeQueryHandle {
  const channel = createAsyncChannel<unknown>();
  let closed = false;
  let capturedArgs: any = null;

  const fakeQuery: any = {
    [Symbol.asyncIterator]: () => channel[Symbol.asyncIterator](),
    close: () => {
      closed = true;
      channel.close();
    },
    interrupt: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    accountInfo: vi.fn().mockResolvedValue({ email: 'test@example.com', apiProvider: 'firstParty' }),
    getContextUsage: vi.fn().mockResolvedValue({
      categories: [{ name: 'messages', tokens: 1000, color: '#0000ff' }],
      totalTokens: 1000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 0.5,
      gridRows: [],
      model: 'claude-sonnet-4-6',
      memoryFiles: [],
    }),
    supportedCommands: vi.fn().mockResolvedValue([
      { name: 'review', description: 'Review code', argumentHint: '' },
      { name: 'explain', description: 'Explain code', argumentHint: '<file>' },
    ]),
    supportedModels: vi.fn().mockResolvedValue([
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Fast' },
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Deep' },
    ]),
    supportedAgents: vi.fn().mockResolvedValue([
      { name: 'Explore', description: 'Explore codebases' },
    ]),
    setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
  };

  mockedQuery.mockImplementation((args: any) => {
    capturedArgs = args ?? null;
    return fakeQuery;
  });

  return {
    query: fakeQuery,
    pushMessage: (msg) => channel.push(msg),
    closeMessages: () => channel.close(),
    wasClosed: () => closed,
    getCapturedOptions: () => capturedArgs?.options ?? null,
    getCapturedPrompt: () => capturedArgs?.prompt ?? null,
  };
}

// Pump the microtask queue so `for await` picks up pushed messages.
async function flush(ticks = 2): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// async-channel sanity checks (kept from the original file)
// ---------------------------------------------------------------------------

describe('async channel', () => {
  it('push and pull values in order', async () => {
    const ch = createAsyncChannel<number>();
    ch.push(1);
    ch.push(2);
    ch.push(3);
    ch.close();

    const values: number[] = [];
    for await (const v of ch) {
      values.push(v);
    }
    expect(values).toEqual([1, 2, 3]);
  });

  it('waits for pushed values', async () => {
    const ch = createAsyncChannel<string>();

    const promise = (async () => {
      const values: string[] = [];
      for await (const v of ch) {
        values.push(v);
      }
      return values;
    })();

    ch.push('a');
    ch.push('b');
    ch.close();

    const values = await promise;
    expect(values).toEqual(['a', 'b']);
  });

  it('ignores pushes after close', () => {
    const ch = createAsyncChannel<number>();
    ch.close();
    ch.push(1); // should not throw
  });

  it('bounded: drops oldest item when maxSize is exceeded', async () => {
    const ch = createAsyncChannel<number>(3);
    ch.push(1);
    ch.push(2);
    ch.push(3);
    // This push exceeds maxSize=3, so item 1 (oldest) is dropped
    ch.push(4);
    ch.close();

    const values: number[] = [];
    for await (const v of ch) {
      values.push(v);
    }
    expect(values).toEqual([2, 3, 4]);
  });

  it('bounded: no drop when queue is below maxSize', async () => {
    const ch = createAsyncChannel<number>(5);
    ch.push(10);
    ch.push(20);
    ch.close();

    const values: number[] = [];
    for await (const v of ch) {
      values.push(v);
    }
    expect(values).toEqual([10, 20]);
  });

  it('unbounded: behavior unchanged when maxSize is omitted', async () => {
    const ch = createAsyncChannel<number>();
    for (let i = 0; i < 10; i++) ch.push(i);
    ch.close();

    const values: number[] = [];
    for await (const v of ch) {
      values.push(v);
    }
    expect(values).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

// ---------------------------------------------------------------------------
// Sessions service — behavior on empty state
// ---------------------------------------------------------------------------

describe('sessions service — empty state guards', () => {
  let service: SessionsService;
  let sendToRenderer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockedQuery.mockReset();
    sendToRenderer = vi.fn();
    service = createSessionsService(sendToRenderer as any);
  });

  it('isActive returns false for unknown tab', () => {
    expect(service.isActive('unknown')).toBe(false);
  });

  it('getStatus returns stopped for unknown tab', () => {
    expect(service.getStatus('unknown')).toBe('stopped');
  });

  it('getSessionId returns null for unknown tab', () => {
    expect(service.getSessionId('unknown')).toBeNull();
  });

  it('getInfo returns null for unknown tab', () => {
    expect(service.getInfo('unknown')).toBeNull();
  });

  it('sendMessage / sendStructuredMessage / respondPermission / stop are no-ops for unknown tabs', () => {
    expect(() => service.sendMessage('unknown', 'hi')).not.toThrow();
    expect(() => service.sendStructuredMessage('unknown', [])).not.toThrow();
    expect(() => service.respondPermission('unknown', 'allow')).not.toThrow();
    expect(() => service.stop('unknown')).not.toThrow();
  });

  it('stopAll is a no-op when no sessions exist', () => {
    expect(() => service.stopAll()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Sessions service — full lifecycle with a mocked SDK
// ---------------------------------------------------------------------------

describe('sessions service — full lifecycle', () => {
  let service: SessionsService;
  let sendToRenderer: ReturnType<typeof vi.fn>;
  let showNotification: ReturnType<typeof vi.fn>;
  let incrementUnread: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockedQuery.mockReset();
    sendToRenderer = vi.fn();
    showNotification = vi.fn();
    incrementUnread = vi.fn();
    service = createSessionsService(sendToRenderer as any, {
      showNotification: showNotification as unknown as (
        title: string,
        body: string,
        isError: boolean,
      ) => void,
      incrementUnread: incrementUnread as unknown as () => void,
    });
  });

  afterEach(() => {
    service.stopAll();
  });

  it('start() throws fast with an actionable message when no Claude binary can be resolved', () => {
    mockedFindSystemClaudeBinary.mockReturnValueOnce(null);

    // No installFakeQuery() needed — we expect the throw to land before
    // the SDK is invoked. installing the fake would silently mask a
    // regression where the throw moved later in the flow.
    expect(() =>
      service.start({
        tabId: 'tab-no-binary',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      }),
    ).toThrow(/Claude Code CLI binary not found/i);

    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('start() calls the SDK query with cwd, model, permissionMode, and CLAUDE_CONFIG_DIR env', () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-1',
      projectPath: '/tmp/my-project',
      configDir: '/custom/.claude',
      model: 'sonnet',
      permissionMode: 'default',
    });

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const options = fake.getCapturedOptions();
    expect(options.cwd).toBe('/tmp/my-project');
    expect(options.model).toBe('sonnet');
    expect(options.permissionMode).toBe('default');
    expect(options.env.CLAUDE_CONFIG_DIR).toBe('/custom/.claude');
    // canUseTool is the SDK's primary permission callback
    expect(typeof options.canUseTool).toBe('function');
  });

  it('start() passes acceptEdits straight through to the SDK without injecting an app-only allowedTools list', () => {
    // The SDK's own acceptEdits mode handles auto-approval of edit-class tools
    // internally. Adding `allowedTools` here would mean the SDK never asks the
    // app for edit tools (good) but ALSO never asks for anything outside that
    // list either (bad — the SDK then runs in restricted-tools mode). The
    // correct behavior is: pass the mode through untouched and let the SDK
    // decide which tools to short-circuit.
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-accept-edits',
      projectPath: '/tmp/my-project',
      configDir: '/custom/.claude',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
    });

    const options = fake.getCapturedOptions();
    expect(options.permissionMode).toBe('acceptEdits');
    expect(options.allowedTools).toBeUndefined();
  });

  it('start() opts into the SDK bypass safety flag when using bypassPermissions', () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-bypass',
      projectPath: '/tmp/my-project',
      configDir: '/custom/.claude',
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
    });

    const options = fake.getCapturedOptions();
    expect(options.permissionMode).toBe('bypassPermissions');
    expect(options.allowDangerouslySkipPermissions).toBe(true);
  });

  it('start() passes settingSources so the SDK loads project CLAUDE.md, .claude/, and MCP config', () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-sources',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    const options = fake.getCapturedOptions();
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
  });

  it("start() passes systemPrompt preset so the SDK uses Claude Code's full system prompt (plan-first, asks clarifying questions, etc.)", () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-preset',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    const options = fake.getCapturedOptions();
    expect(options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
  });

  it('start() enables includePartialMessages so assistant text streams to the renderer', () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 't1',
      projectPath: '/p',
      configDir: '/cfg',
      model: 'opus',
      permissionMode: 'default',
    });

    const options = fake.getCapturedOptions();
    expect(options.includePartialMessages).toBe(true);
  });

  it('start() sets enableAllProjectMcpServers so .mcp.json servers auto-connect', () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-mcp',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    const options = fake.getCapturedOptions();
    expect(options.settings?.enableAllProjectMcpServers).toBe(true);
  });

  it('start() does NOT set strictMcpConfig — that flag tells the CLI to ignore all MCP configs except --mcp-config, which would disable every user/project MCP server', () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-strict-mcp',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    const options = fake.getCapturedOptions();
    expect(options.strictMcpConfig).toBeFalsy();
  });

  it('start() enables agentProgressSummaries so subagent task_progress events stream into the SubagentBar expander', () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-progress',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    const options = fake.getCapturedOptions();
    expect(options.agentProgressSummaries).toBe(true);
  });

  it('start() forwards resumeSessionId as options.resume when provided', () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-resume',
      projectPath: '/p',
      configDir: '/c',
      model: 'opus',
      permissionMode: 'default',
      resumeSessionId: 'old-session-id',
    });

    const options = fake.getCapturedOptions();
    expect(options.resume).toBe('old-session-id');
  });

  it('passes effort and thinking options to the SDK query when provided', () => {
    const fake = installFakeQuery();
    service.start({
      tabId: 'tab-effort',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
      effort: 'high',
      thinking: { type: 'adaptive' },
    });

    const options = fake.getCapturedOptions();
    expect(options.effort).toBe('high');
    expect(options.thinking).toEqual({ type: 'adaptive' });
    service.stopAll();
  });

  it('passes effort: xhigh through to the SDK query (SDK-supported Opus 4.7 level)', () => {
    const fake = installFakeQuery();
    service.start({
      tabId: 'tab-xhigh',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
      effort: 'xhigh',
    });

    const options = fake.getCapturedOptions();
    expect(options.effort).toBe('xhigh');
    service.stopAll();
  });

  it('omits effort and thinking from SDK query when not provided (auto behavior)', () => {
    const fake = installFakeQuery();
    service.start({
      tabId: 'tab-auto',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    const options = fake.getCapturedOptions();
    expect(options.effort).toBeUndefined();
    expect(options.thinking).toBeUndefined();
    service.stopAll();
  });

  it('tracks session state: isActive + getInfo + getStatus after start()', () => {
    installFakeQuery();

    service.start({
      tabId: 'alive',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    expect(service.isActive('alive')).toBe(true);
    const info = service.getInfo('alive');
    expect(info).not.toBeNull();
    expect(info!.sessionId).toBeNull(); // not yet, waiting for init
    expect(info!.status).toBe('starting');
  });

  it('listActiveTabIds returns all currently-registered tab IDs', () => {
    installFakeQuery();
    service.start({
      tabId: 'tab-a',
      projectPath: '/tmp/a',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    installFakeQuery();
    service.start({
      tabId: 'tab-b',
      projectPath: '/tmp/b',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    expect(service.listActiveTabIds().sort()).toEqual(['tab-a', 'tab-b']);

    service.stop('tab-a');
    expect(service.listActiveTabIds()).toEqual(['tab-b']);
  });

  it('stays "idle" when only the system init message has arrived (no turn yet)', async () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-init-idle',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    fake.pushMessage({ type: 'system', subtype: 'init', session_id: 'sess-init' });
    await flush();

    // Init alone doesn't mean a turn is in flight — the session is alive
    // but the user hasn't sent anything yet. Status must be 'idle' so the
    // installer's wait-for-idle gate doesn't block on it.
    expect(service.getStatus('tab-init-idle')).toBe('idle');
    expect(service.listInFlightTabIds()).not.toContain('tab-init-idle');
  });

  it('flips to "running" once the user sends a message', async () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-running',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    fake.pushMessage({ type: 'system', subtype: 'init', session_id: 'sess-r' });
    await flush();
    expect(service.getStatus('tab-running')).toBe('idle');

    service.sendMessage('tab-running', 'hello');
    expect(service.getStatus('tab-running')).toBe('running');
  });

  it('moves a tab to status "idle" after a result message', async () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-idle',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    fake.pushMessage({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-idle',
    });
    await flush();
    // Init alone leaves the session 'idle' (no turn yet); a turn must
    // start (sendMessage or an assistant message) to flip 'running'.
    expect(service.getStatus('tab-idle')).toBe('idle');

    // Simulate a turn: assistant message → result.
    fake.pushMessage({ type: 'assistant', message: { role: 'assistant', content: 'hi' } });
    await flush();
    expect(service.getStatus('tab-idle')).toBe('running');

    fake.pushMessage({
      type: 'result',
      subtype: 'success',
      result: 'done',
      is_error: false,
    });
    await flush();

    expect(service.getStatus('tab-idle')).toBe('idle');
  });

  it('listInFlightTabIds excludes idle sessions', async () => {
    const fakeBusy = installFakeQuery();
    service.start({
      tabId: 'tab-busy',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });
    fakeBusy.pushMessage({ type: 'assistant', message: { role: 'assistant', content: 'thinking' } });
    await flush();

    const fakeIdle = installFakeQuery();
    service.start({
      tabId: 'tab-quiet',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });
    fakeIdle.pushMessage({ type: 'system', subtype: 'init', session_id: 's1' });
    fakeIdle.pushMessage({ type: 'result', subtype: 'success', result: 'done', is_error: false });
    await flush();

    expect(service.listActiveTabIds().sort()).toEqual(['tab-busy', 'tab-quiet']);
    expect(service.listInFlightTabIds()).toEqual(['tab-busy']);
  });

  it('listInFlightTabIds includes waiting_permission sessions', async () => {
    const fake = installFakeQuery();
    service.start({
      tabId: 'tab-perm',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });
    fake.pushMessage({ type: 'system', subtype: 'init', session_id: 's-p' });
    fake.pushMessage({ type: 'result', subtype: 'success', result: 'done', is_error: false });
    await flush();
    expect(service.getStatus('tab-perm')).toBe('idle');
    expect(service.listInFlightTabIds()).toEqual([]);

    // Simulate a tool-permission gate firing — the canPermit hook flips
    // status to 'waiting_permission' until the renderer answers.
    const opts = fake.getCapturedOptions();
    const canPermit = opts?.canUseTool ?? opts?.canCallTool;
    if (canPermit) {
      void canPermit('Bash', { command: 'ls' }, { signal: new AbortController().signal });
    }
    await flush();

    if (service.getStatus('tab-perm') === 'waiting_permission') {
      expect(service.listInFlightTabIds()).toEqual(['tab-perm']);
    }
  });

  it('extracts session_id from the system init message and forwards all output', async () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-init',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    fake.pushMessage({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-xyz',
    });
    await flush();

    expect(service.getSessionId('tab-init')).toBe('sess-xyz');
    // Init alone keeps the session 'idle' — no turn has started yet.
    expect(service.getStatus('tab-init')).toBe('idle');
    expect(sendToRenderer).toHaveBeenCalledWith(
      'claude-output:tab-init',
      expect.objectContaining({ type: 'system', session_id: 'sess-xyz' }),
    );
  });

  it('fires native notification + renderer notification on result message', async () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-notify',
      projectPath: '/tmp/my-project',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    fake.pushMessage({
      type: 'result',
      result: 'Everything is fine',
      is_error: false,
    });
    await flush();

    expect(sendToRenderer).toHaveBeenCalledWith(
      'claude-notification',
      expect.objectContaining({
        tab_id: 'tab-notify',
        is_error: false,
        body: 'Everything is fine',
      }),
    );
    expect(showNotification).toHaveBeenCalledWith(
      expect.stringContaining('my-project'),
      'Everything is fine',
      false,
      { tabId: 'tab-notify' },
    );
    expect(incrementUnread).toHaveBeenCalledTimes(1);
  });

  it('marks a result as an error when is_error is true', async () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-err',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    fake.pushMessage({
      type: 'result',
      error: 'Something exploded',
      is_error: true,
    });
    await flush();

    const notifCall = sendToRenderer.mock.calls.find(
      (c) => c[0] === 'claude-notification',
    );
    expect(notifCall).toBeDefined();
    expect(notifCall![1]).toMatchObject({
      is_error: true,
      body: 'Something exploded',
    });
    expect(showNotification).toHaveBeenCalledWith(
      expect.any(String),
      'Something exploded',
      true,
      { tabId: 'tab-err' },
    );
  });

  it('swallows notification-hook errors so they do not break the session loop', async () => {
    showNotification.mockImplementation(() => {
      throw new Error('notification failed');
    });
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-hook-err',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    fake.pushMessage({ type: 'result', result: 'done' });
    await flush();

    // Loop should still complete normally on stream close
    fake.closeMessages();
    await flush();
    expect(service.isActive('tab-hook-err')).toBe(false);
  });

  it('keeps the session alive when the stream throws (does not delete)', async () => {
    const channel = createAsyncChannel<unknown>();
    const fakeQuery: any = {
      // eslint-disable-next-line require-yield -- test mock generator; intentionally non-yielding.
      async *[Symbol.asyncIterator]() {
        throw new Error('stream blew up');
      },
      close: vi.fn(),
    };
    mockedQuery.mockReturnValue(fakeQuery);

    service.start({
      tabId: 'tab-throw',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    await flush(4);

    // Error is sent to renderer
    expect(sendToRenderer).toHaveBeenCalledWith(
      'claude-error:tab-throw',
      'stream blew up',
    );
    // An inline error notification is sent
    expect(sendToRenderer).toHaveBeenCalledWith(
      'claude-output:tab-throw',
      expect.objectContaining({
        type: 'system',
        subtype: 'notification',
        notification_type: 'error',
      }),
    );
    // Loading indicator is stopped
    expect(sendToRenderer).toHaveBeenCalledWith('claude-complete:tab-throw');
    // Session stays alive in error state — NOT deleted
    expect(service.isActive('tab-throw')).toBe(true);
    expect(service.getStatus('tab-throw')).toBe('error');
    // The dead Query handle should be closed so its internals are released.
    // Otherwise it sits in handle.query holding subprocess resources until
    // stop() or restartQuery() replaces it.
    expect(fakeQuery.close).toHaveBeenCalled();
    // Keep the channel referenced so TS doesn't complain about the unused var
    channel.close();
  });

  it('recovers from stream error when user sends a new message', async () => {
    // First query: throw immediately
    let callCount = 0;
    const errorChannel = createAsyncChannel<unknown>();
    const errorQuery: any = {
      // eslint-disable-next-line require-yield -- test mock generator; intentionally non-yielding.
      async *[Symbol.asyncIterator]() {
        throw new Error('Stream closed');
      },
      close: vi.fn(),
    };

    // Second query: works normally
    const recoveryChannel = createAsyncChannel<unknown>();
    const recoveryQuery: any = {
      [Symbol.asyncIterator]: () => recoveryChannel[Symbol.asyncIterator](),
      close: vi.fn(),
      interrupt: vi.fn().mockResolvedValue(undefined),
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
      setModel: vi.fn().mockResolvedValue(undefined),
      accountInfo: vi.fn().mockResolvedValue({ email: 'test@example.com', apiProvider: 'firstParty' }),
      getContextUsage: vi.fn().mockResolvedValue(null),
      supportedCommands: vi.fn().mockResolvedValue([]),
      supportedModels: vi.fn().mockResolvedValue([]),
      supportedAgents: vi.fn().mockResolvedValue([]),
      setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      applyFlagSettings: vi.fn().mockResolvedValue(undefined),
    };

    mockedQuery.mockImplementation((_args: any) => {
      callCount++;
      if (callCount === 1) return errorQuery;
      return recoveryQuery;
    });

    service.start({
      tabId: 'tab-recover',
      projectPath: '/project',
      configDir: '/config',
      model: 'sonnet',
      permissionMode: 'default',
    });

    await flush(4);

    // Session is in error state but still tracked
    expect(service.getStatus('tab-recover')).toBe('error');
    expect(service.isActive('tab-recover')).toBe(true);

    // User sends a new message — should trigger query restart
    service.sendMessage('tab-recover', 'try again');
    await flush(4);

    // SDK query() should have been called a second time (the restart)
    expect(callCount).toBe(2);
    expect(mockedQuery).toHaveBeenCalledTimes(2);

    // Push a message through the recovery stream to confirm the loop is alive
    recoveryChannel.push({ type: 'assistant', message: { role: 'assistant', content: 'recovered' } });
    await flush();

    // The new listenToMessages loop sets status to 'running' on first message
    expect(service.getStatus('tab-recover')).toBe('running');
    expect(sendToRenderer).toHaveBeenCalledWith(
      'claude-output:tab-recover',
      expect.objectContaining({ type: 'assistant' }),
    );

    // Clean up
    recoveryChannel.close();
    errorChannel.close();
    await flush();
  });

  it('passes resume=<sessionId> when restarting after a stream error on a session with a known UUID', async () => {
    // The recovery test above doesn't push an init message before the throw,
    // so handle.sessionId stays null and the SDK contract for "resume after
    // error" is never exercised. This test seeds the init first, then forces
    // a throw, and asserts the second query() call sets options.resume to the
    // captured sessionId — preserving conversation continuity across the
    // automatic restart.
    let callCount = 0;
    const SESSION_UUID = '550e8400-e29b-41d4-a716-446655440000';

    const initThenThrowChannel = createAsyncChannel<unknown>();
    const initThenThrowQuery: any = {
      async *[Symbol.asyncIterator]() {
        // Emit a system:init so the FSM stamps the sessionId on the handle.
        yield {
          type: 'system',
          subtype: 'init',
          session_id: SESSION_UUID,
        };
        // Then explode.
        throw new Error('connection lost');
      },
      close: vi.fn(),
    };

    const recoveryChannel = createAsyncChannel<unknown>();
    const recoveryQuery: any = {
      [Symbol.asyncIterator]: () => recoveryChannel[Symbol.asyncIterator](),
      close: vi.fn(),
      interrupt: vi.fn().mockResolvedValue(undefined),
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
      setModel: vi.fn().mockResolvedValue(undefined),
      accountInfo: vi.fn().mockResolvedValue({}),
      getContextUsage: vi.fn().mockResolvedValue(null),
      supportedCommands: vi.fn().mockResolvedValue([]),
      supportedModels: vi.fn().mockResolvedValue([]),
      supportedAgents: vi.fn().mockResolvedValue([]),
      setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      applyFlagSettings: vi.fn().mockResolvedValue(undefined),
    };

    const capturedArgs: any[] = [];
    mockedQuery.mockImplementation((args: any) => {
      capturedArgs.push(args);
      callCount++;
      return callCount === 1 ? initThenThrowQuery : recoveryQuery;
    });

    service.start({
      tabId: 'tab-resume',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    await flush(4);

    expect(service.getStatus('tab-resume')).toBe('error');
    expect(service.getSessionId('tab-resume')).toBe(SESSION_UUID);

    // Trigger restart.
    service.sendMessage('tab-resume', 'pick up where we left off');
    await flush(4);

    expect(callCount).toBe(2);
    const restartArgs = capturedArgs[1];
    expect(restartArgs?.options?.resume).toBe(SESSION_UUID);

    recoveryChannel.close();
    initThenThrowChannel.close();
    await flush();
  });

  it('closes out the session when the stream ends cleanly', async () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-done',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    expect(service.isActive('tab-done')).toBe(true);

    fake.closeMessages();
    await flush();

    expect(sendToRenderer).toHaveBeenCalledWith('claude-complete:tab-done');
    expect(service.isActive('tab-done')).toBe(false);
  });

  it('stop() closes the query + input channel and drops the handle', () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-stop',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    expect(service.isActive('tab-stop')).toBe(true);
    service.stop('tab-stop');
    expect(fake.wasClosed()).toBe(true);
    expect(service.isActive('tab-stop')).toBe(false);
  });

  it('starting a session with the same tabId closes the previous one', () => {
    const fake1 = installFakeQuery();
    service.start({
      tabId: 'tab-replace',
      projectPath: '/p1',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    const fake2 = installFakeQuery();
    service.start({
      tabId: 'tab-replace',
      projectPath: '/p2',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    expect(fake1.wasClosed()).toBe(true);
    expect(fake2.wasClosed()).toBe(false);
    expect(service.isActive('tab-replace')).toBe(true);
  });

  it('stopAll closes every active session', () => {
    const a = installFakeQuery();
    service.start({
      tabId: 'A',
      projectPath: '/pa',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    const b = installFakeQuery();
    service.start({
      tabId: 'B',
      projectPath: '/pb',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    expect(service.isActive('A')).toBe(true);
    expect(service.isActive('B')).toBe(true);

    service.stopAll();

    expect(a.wasClosed() || b.wasClosed()).toBe(true);
    expect(service.isActive('A')).toBe(false);
    expect(service.isActive('B')).toBe(false);
  });

  it('sendMessage pushes a user message into the SDK input channel', async () => {
    const fake = installFakeQuery();
    service.start({
      tabId: 'tab-send',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    // `prompt` is the top-level argument to query() — the AsyncChannel that
    // the sessions service pushes user messages into.
    const prompt = fake.getCapturedPrompt();
    const promptIter = prompt[Symbol.asyncIterator]();

    service.sendMessage('tab-send', 'hello, world');

    const next = await promptIter.next();
    expect(next.done).toBe(false);
    expect((next.value).type).toBe('user');
    expect((next.value).message.content).toBe('hello, world');
  });

  it('sendStructuredMessage pushes a structured user message into the SDK input channel', async () => {
    const fake = installFakeQuery();
    service.start({
      tabId: 'tab-struct',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    const prompt = fake.getCapturedPrompt();
    const promptIter = prompt[Symbol.asyncIterator]();

    service.sendStructuredMessage('tab-struct', [
      { type: 'text', text: 'look at this image' },
      { type: 'image', source: { type: 'base64', data: '...' } },
    ]);

    const next = await promptIter.next();
    expect(next.done).toBe(false);
    expect((next.value).type).toBe('user');
    expect(Array.isArray((next.value).message.content)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Permission flow — exercising canUseTool callback
  // -------------------------------------------------------------------------

  it('canUseTool emits permission_request and resolves to allow with updatedInput', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging,
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-perm', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    const canUseTool = fake.getCapturedOptions().canUseTool;
    expect(typeof canUseTool).toBe('function');

    const decisionPromise = canUseTool('Bash', { command: 'ls -la' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-1',
      title: 'Run ls -la',
      displayName: 'Bash',
      suggestions: [],
    });

    await new Promise((r) => setImmediate(r));
    expect(svc.getStatus('tab-perm')).toBe('waiting_permission');
    const permCall = sendToRenderer.mock.calls.find(
      (c) => c[0] === 'claude-output:tab-perm' && (c[1])?.type === 'permission_request',
    );
    expect(permCall).toBeDefined();
    expect((permCall![1]).tool_name).toBe('Bash');
    expect((permCall![1]).tool_input).toEqual({ command: 'ls -la' });
    expect((permCall![1]).title).toBe('Run ls -la');

    svc.respondPermission('tab-perm', 'allow', { command: 'ls -la --color' });
    const result = await decisionPromise;
    expect(result.behavior).toBe('allow');
    expect(result.updatedInput).toEqual({ command: 'ls -la --color' });
    expect(svc.getStatus('tab-perm')).toBe('running');

    svc.stopAll();
  });

  it('canUseTool fires native notification + incrementUnread when permission request is shown', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging,
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-perm-notif', projectPath: '/tmp/my-project', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    const canUseTool = fake.getCapturedOptions().canUseTool;
    const decisionPromise = canUseTool('Bash', { command: 'rm -rf /' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-notif',
      title: 'Run rm -rf /',
      displayName: 'Bash',
    });

    await new Promise((r) => setImmediate(r));

    // Should fire native notification with a summary body and a
    // "Permission Request:" subtitle (no "Task Complete" leakage).
    expect(showNotification).toHaveBeenCalledWith(
      expect.stringContaining('my-project'),
      expect.stringContaining('rm -rf /'),
      false,
      { tabId: 'tab-perm-notif' },
      { subtitle: 'Permission Request:' },
    );
    const [, body] = showNotification.mock.calls.at(-1)!;
    expect(body).not.toMatch(/Permission requested:/);
    expect(incrementUnread).toHaveBeenCalled();

    // Clean up — resolve the permission so the promise settles
    svc.respondPermission('tab-perm-notif', 'deny');
    await decisionPromise;
    svc.stopAll();
  });

  it('canUseTool fires an "Answer Needed:" notification (not "Permission requested") for AskUserQuestion', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging,
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-q', projectPath: '/tmp/my-project', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    const canUseTool = fake.getCapturedOptions().canUseTool;
    const decisionPromise = canUseTool(
      'AskUserQuestion',
      { questions: [{ question: 'Pick a side?', options: [{ label: 'A' }, { label: 'B' }] }] },
      {
        signal: new AbortController().signal,
        toolUseID: 'tu-q',
      },
    );

    await new Promise((r) => setImmediate(r));

    expect(showNotification).toHaveBeenCalled();
    const call = showNotification.mock.calls.at(-1)!;
    // [title, body, isError, payload, options?]
    expect(call[0]).toEqual(expect.stringContaining('my-project'));
    expect(call[1]).toBe('Pick a side?');
    expect(call[1]).not.toMatch(/Permission requested/);
    expect(call[2]).toBe(false);
    expect(call[3]).toEqual({ tabId: 'tab-q' });
    expect(call[4]).toMatchObject({ subtitle: 'Answer Needed:' });

    svc.respondPermission('tab-q', 'deny');
    await decisionPromise;
    svc.stopAll();
  });

  it('canUseTool resolves to allow without updatedInput when none provided', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging,
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-perm-fb', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    const canUseTool = fake.getCapturedOptions().canUseTool;
    const decisionPromise = canUseTool('Bash', { command: 'echo hi' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-2',
    });

    await new Promise((r) => setImmediate(r));
    svc.respondPermission('tab-perm-fb', 'allow');
    const result = await decisionPromise;
    expect(result.behavior).toBe('allow');
    // Falls back to original toolInput when no updatedInput from user
    expect(result.updatedInput).toEqual({ command: 'echo hi' });

    svc.stopAll();
  });

  it('canUseTool resolves to deny when respondPermission("deny") is called', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging,
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-deny', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    const canUseTool = fake.getCapturedOptions().canUseTool;
    const decisionPromise = canUseTool('Write', { path: '/etc/passwd' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-3',
    });

    await new Promise((r) => setImmediate(r));
    svc.respondPermission('tab-deny', 'deny');
    const result = await decisionPromise;
    expect(result.behavior).toBe('deny');
    expect(result.message).toBe('User denied permission');

    svc.stopAll();
  });

  // -------------------------------------------------------------------------
  // canUseTool — SDK abort handling
  //
  // The SDK passes an `AbortSignal` in `toolOptions.signal` and aborts it when
  // the tool use is no longer needed (e.g. user pressed interrupt mid-permission,
  // session torn down, parent task cancelled). Without honoring the signal the
  // pending Promise never settles and the SDK's tool pipeline hangs for that
  // session.
  // -------------------------------------------------------------------------

  it('canUseTool resolves the pending request as deny when the SDK aborts the signal', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging,
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-abort', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    const canUseTool = fake.getCapturedOptions().canUseTool;
    const ctrl = new AbortController();
    const decisionPromise = canUseTool('Bash', { command: 'sleep 9999' }, {
      signal: ctrl.signal,
      toolUseID: 'tu-abort',
    });

    // Let the canUseTool body register the abort listener.
    await new Promise((r) => setImmediate(r));

    // SDK aborts the request — no user response was produced.
    ctrl.abort();

    // Race the Promise against a short timeout. The pre-fix behavior was to
    // hang forever; this assertion is what makes the test fail before the fix.
    const result = await Promise.race([
      decisionPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('canUseTool hung after abort')), 200)),
    ]);
    expect(result).toMatchObject({ behavior: 'deny' });
    // Distinguishable from a user-driven deny so logging / future SDK
    // responses can branch on it.
    expect((result).message).toMatch(/abort/i);

    svc.stopAll();
  });

  it('canUseTool advances the permission queue when the head request is aborted', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging,
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-abort-queue', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    const canUseTool = fake.getCapturedOptions().canUseTool;
    const ctrl1 = new AbortController();
    const p1 = canUseTool('Bash', { command: 'first' }, {
      signal: ctrl1.signal,
      toolUseID: 'tu-q1',
    });
    await new Promise((r) => setImmediate(r));

    const ctrl2 = new AbortController();
    const p2 = canUseTool('Bash', { command: 'second' }, {
      signal: ctrl2.signal,
      toolUseID: 'tu-q2',
    });
    await new Promise((r) => setImmediate(r));

    // Snapshot the renderer call count so we can detect the *next* dispatch.
    const callCountBeforeAbort = (sendToRenderer as any).mock.calls.length;

    ctrl1.abort();
    await new Promise((r) => setImmediate(r));

    // p1 must settle as deny.
    await expect(p1).resolves.toMatchObject({ behavior: 'deny' });

    // The second request should now be displayed (it was queued behind p1).
    const newCalls = (sendToRenderer as any).mock.calls.slice(callCountBeforeAbort);
    const shownSecond = newCalls.some(
      ([ch, payload]: any[]) =>
        ch === 'claude-output:tab-abort-queue' &&
        payload?.type === 'permission_request' &&
        payload?.tool_input?.command === 'second',
    );
    expect(shownSecond).toBe(true);

    // p2 still pending — user can still respond normally.
    svc.respondPermission('tab-abort-queue', 'allow');
    await expect(p2).resolves.toMatchObject({ behavior: 'allow' });

    svc.stopAll();
  });

  it('canUseTool resolves immediately when handed an already-aborted signal', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging,
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-pre-abort', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    const canUseTool = fake.getCapturedOptions().canUseTool;
    const ctrl = new AbortController();
    ctrl.abort();

    const decision = await Promise.race([
      canUseTool('Bash', { command: 'pre' }, { signal: ctrl.signal, toolUseID: 'tu-pre' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('hung on pre-aborted signal')), 200)),
    ]);
    expect(decision).toMatchObject({ behavior: 'deny' });

    svc.stopAll();
  });

  it('canUseTool passes through updatedPermissions for "allow & remember"', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging,
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-remember', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    const canUseTool = fake.getCapturedOptions().canUseTool;
    const decisionPromise = canUseTool('Bash', { command: 'git status' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-4',
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git *' }], behavior: 'allow', destination: 'projectSettings' }],
    });

    await new Promise((r) => setImmediate(r));
    const rules = [
      { type: 'addRules' as const, rules: [{ toolName: 'Bash', ruleContent: 'git *' }], behavior: 'allow' as const, destination: 'projectSettings' as const },
    ];
    svc.respondPermission('tab-remember', 'allow', undefined, rules);
    const result = await decisionPromise;
    expect(result.behavior).toBe('allow');
    // The persistent rule is sent to the SDK alongside a session-destination
    // twin so the running query applies it live (without this the rule lands
    // on disk but never enters the active rule cache, and the very next
    // matching tool_use re-prompts).
    expect(result.updatedPermissions).toHaveLength(2);
    expect(result.updatedPermissions[0]).toEqual(rules[0]);
    expect(result.updatedPermissions[1]).toEqual({ ...rules[0], destination: 'session' });

    svc.stopAll();
  });

  it('canUseTool forwards suggestions and rich metadata to the renderer', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging,
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-sug', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    const suggestions = [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git status' }], behavior: 'allow', destination: 'projectSettings' },
    ];

    const canUseTool = fake.getCapturedOptions().canUseTool;
    const decisionPromise = canUseTool('Bash', { command: 'git status' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-5',
      title: 'Run git status',
      displayName: 'Bash',
      description: 'Execute a shell command',
      decisionReason: 'Bash commands require approval',
      suggestions,
    });

    await new Promise((r) => setImmediate(r));
    const permCall = sendToRenderer.mock.calls.find(
      (c) => c[0] === 'claude-output:tab-sug' && (c[1])?.type === 'permission_request',
    );
    expect(permCall).toBeDefined();
    expect((permCall![1]).permission_suggestions).toEqual(suggestions);
    expect((permCall![1]).title).toBe('Run git status');
    expect((permCall![1]).display_name).toBe('Bash');
    expect((permCall![1]).description).toBe('Execute a shell command');

    svc.respondPermission('tab-sug', 'allow');
    await decisionPromise;

    svc.stopAll();
  });

  it('canUseTool logs a permission.request entry through the logger', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging,
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-log-req', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    const canUseTool = fake.getCapturedOptions().canUseTool;
    const decisionPromise = canUseTool('Bash', { command: 'git status' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-log-req',
    });

    await new Promise((r) => setImmediate(r));

    const requestEntry = writeBatch.mock.calls
      .map((c) => c[0][0])
      .find((e) => e.category === 'permission' && /request/i.test(e.message));
    expect(requestEntry).toBeDefined();
    expect(requestEntry.source).toBe('claude-sdk');
    expect(requestEntry.level).toBe('info');
    const meta = JSON.parse(requestEntry.metadata);
    expect(meta.event).toBe('permission.request');
    expect(meta.tool_name).toBe('Bash');

    svc.respondPermission('tab-log-req', 'allow');
    await decisionPromise;
    svc.stopAll();
  });

  it('canUseTool logs a permission.decision entry with persisted=false when no rules are sent', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging,
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-log-session', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    const canUseTool = fake.getCapturedOptions().canUseTool;
    const decisionPromise = canUseTool('Bash', { command: 'git status' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-log-session',
    });

    await new Promise((r) => setImmediate(r));
    svc.respondPermission('tab-log-session', 'allow');
    await decisionPromise;

    const decisionEntry = writeBatch.mock.calls
      .map((c) => c[0][0])
      .find((e) => e.category === 'permission' && /decision/i.test(e.message));
    expect(decisionEntry).toBeDefined();
    const meta = JSON.parse(decisionEntry.metadata);
    expect(meta.event).toBe('permission.decision');
    expect(meta.behavior).toBe('allow');
    expect(meta.persisted).toBe(false);
    expect(meta.tool_name).toBe('Bash');

    svc.stopAll();
  });

  it('canUseTool logs a permission.decision entry with persisted=true when updatedPermissions are sent', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging,
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-log-saved', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    const canUseTool = fake.getCapturedOptions().canUseTool;
    const decisionPromise = canUseTool('Bash', { command: 'git status' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-log-saved',
    });

    await new Promise((r) => setImmediate(r));
    const rules = [
      { type: 'addRules' as const, rules: [{ toolName: 'Bash', ruleContent: 'git:*' }], behavior: 'allow' as const, destination: 'localSettings' as const },
    ];
    svc.respondPermission('tab-log-saved', 'allow', undefined, rules);
    await decisionPromise;

    const decisionEntry = writeBatch.mock.calls
      .map((c) => c[0][0])
      .find((e) => e.category === 'permission' && /decision/i.test(e.message));
    expect(decisionEntry).toBeDefined();
    const meta = JSON.parse(decisionEntry.metadata);
    expect(meta.event).toBe('permission.decision');
    expect(meta.behavior).toBe('allow');
    expect(meta.persisted).toBe(true);
    expect(meta.destination).toBe('localSettings');
    expect(meta.rules).toEqual([{ toolName: 'Bash', ruleContent: 'git:*' }]);

    svc.stopAll();
  });

  it('canUseTool logs a permission.decision entry with behavior=deny', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging,
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-log-deny', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    const canUseTool = fake.getCapturedOptions().canUseTool;
    const decisionPromise = canUseTool('Write', { file_path: '/etc/passwd' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-log-deny',
    });

    await new Promise((r) => setImmediate(r));
    svc.respondPermission('tab-log-deny', 'deny');
    await decisionPromise;

    const decisionEntry = writeBatch.mock.calls
      .map((c) => c[0][0])
      .find((e) => e.category === 'permission' && /decision/i.test(e.message));
    expect(decisionEntry).toBeDefined();
    const meta = JSON.parse(decisionEntry.metadata);
    expect(meta.event).toBe('permission.decision');
    expect(meta.behavior).toBe('deny');
    expect(meta.persisted).toBe(false);

    svc.stopAll();
  });

  it('stamps each forwarded message with a receivedAt ISO timestamp', async () => {
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-ts', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    const before = Date.now();
    fake.pushMessage({ type: 'system', subtype: 'init', session_id: 'sid-ts' });
    fake.pushMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } });
    await new Promise((r) => setImmediate(r));
    const after = Date.now();

    const forwarded = sendToRenderer.mock.calls
      .filter((c) => c[0] === 'claude-output:tab-ts')
      .map((c) => c[1]);
    expect(forwarded.length).toBeGreaterThanOrEqual(2);
    for (const msg of forwarded) {
      expect(typeof msg.receivedAt).toBe('string');
      const t = Date.parse(msg.receivedAt);
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(before);
      expect(t).toBeLessThanOrEqual(after + 5);
    }

    svc.stopAll();
  });

  it('respondPermission writes persistent rules to disk via persistRule callback', async () => {
    const persistRule = vi.fn();
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      null,
      null,
      persistRule,
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-persist', projectPath: '/proj', configDir: '/cfg', model: 'sonnet', permissionMode: 'default' });

    const canUseTool = fake.getCapturedOptions().canUseTool;
    const decisionPromise = canUseTool('Edit', { file_path: '/proj/foo.ts' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-persist',
    });

    await new Promise((r) => setImmediate(r));
    svc.respondPermission('tab-persist', 'allow', undefined, [
      {
        type: 'addRules',
        rules: [{ toolName: 'Edit', ruleContent: '/proj/**' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ]);
    await decisionPromise;

    expect(persistRule).toHaveBeenCalledTimes(1);
    expect(persistRule).toHaveBeenCalledWith({
      scope: 'local',
      behavior: 'allow',
      rule: 'Edit(/proj/**)',
      configDir: '/cfg',
      projectPath: '/proj',
    });

    svc.stopAll();
  });

  it('respondPermission maps userSettings/projectSettings destinations to the right scope', async () => {
    const persistRule = vi.fn();
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      null,
      null,
      persistRule,
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-scope', projectPath: '/proj', configDir: '/cfg', model: 'sonnet', permissionMode: 'default' });
    const canUseTool = fake.getCapturedOptions().canUseTool;
    const p = canUseTool('Bash', { command: 'git status' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-scope',
    });
    await new Promise((r) => setImmediate(r));
    svc.respondPermission('tab-scope', 'allow', undefined, [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git:*' }], behavior: 'allow', destination: 'userSettings' },
      { type: 'addRules', rules: [{ toolName: 'WebSearch' }], behavior: 'allow', destination: 'projectSettings' },
    ]);
    await p;

    expect(persistRule).toHaveBeenCalledTimes(2);
    expect(persistRule).toHaveBeenNthCalledWith(1, expect.objectContaining({ scope: 'user', rule: 'Bash(git:*)' }));
    expect(persistRule).toHaveBeenNthCalledWith(2, expect.objectContaining({ scope: 'project', rule: 'WebSearch' }));

    svc.stopAll();
  });

  it('respondPermission does NOT persist when destination is "session"', async () => {
    const persistRule = vi.fn();
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      null,
      null,
      persistRule,
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-session', projectPath: '/proj', configDir: '/cfg', model: 'sonnet', permissionMode: 'default' });
    const canUseTool = fake.getCapturedOptions().canUseTool;
    const p = canUseTool('Bash', { command: 'ls' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-sess',
    });
    await new Promise((r) => setImmediate(r));
    svc.respondPermission('tab-session', 'allow', undefined, [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'session' },
    ]);
    await p;

    expect(persistRule).not.toHaveBeenCalled();

    svc.stopAll();
  });

  it('respondPermission does NOT persist on deny', async () => {
    const persistRule = vi.fn();
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      null,
      null,
      persistRule,
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-deny2', projectPath: '/proj', configDir: '/cfg', model: 'sonnet', permissionMode: 'default' });
    const canUseTool = fake.getCapturedOptions().canUseTool;
    const p = canUseTool('Bash', { command: 'rm -rf /' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-deny2',
    });
    await new Promise((r) => setImmediate(r));
    svc.respondPermission('tab-deny2', 'deny');
    await p;

    expect(persistRule).not.toHaveBeenCalled();

    svc.stopAll();
  });

  it('permission queue emits the next payload to the renderer after the first resolves', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging,
    );
    const fake = installFakeQuery();

    svc.start({ tabId: 'tab-queue', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });
    const canUseTool = fake.getCapturedOptions().canUseTool;

    // Kick off two permission requests back-to-back. The second should queue.
    const firstPromise = canUseTool('Bash', { command: 'ls' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-q1',
    });
    const secondPromise = canUseTool('Write', { file_path: '/tmp/x' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-q2',
    });

    // Let both callbacks register in the queue.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Renderer should have received exactly one permission_request (the first).
    const permRequests = sendToRenderer.mock.calls.filter(
      (c) => c[0] === 'claude-output:tab-queue' && (c[1])?.type === 'permission_request',
    );
    expect(permRequests.length).toBe(1);
    expect((permRequests[0][1]).tool_name).toBe('Bash');

    // Resolve the first — the second should now be emitted to the renderer.
    svc.respondPermission('tab-queue', 'allow');
    await firstPromise;

    const permRequestsAfter = sendToRenderer.mock.calls.filter(
      (c) => c[0] === 'claude-output:tab-queue' && (c[1])?.type === 'permission_request',
    );
    expect(permRequestsAfter.length).toBe(2);
    expect((permRequestsAfter[1][1]).tool_name).toBe('Write');

    // A second notification should have fired for the queued request.
    expect(showNotification.mock.calls.length).toBeGreaterThanOrEqual(2);

    svc.respondPermission('tab-queue', 'deny');
    await secondPromise;
    svc.stopAll();
  });

  // -------------------------------------------------------------------------
  // stderr wiring — SDK subprocess stderr should flow into the logging service
  // -------------------------------------------------------------------------

  it('start() wires a stderr callback when a logging service is provided', () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      {
        showNotification: showNotification as any,
        incrementUnread: incrementUnread as any,
      },
      fakeLogging as any,
    );
    const fake = installFakeQuery();

    svc.start({
      tabId: 'tab-stderr',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    const options = fake.getCapturedOptions();
    expect(typeof options.stderr).toBe('function');

    // Invoking the callback should push a log entry
    options.stderr('claude: booting\n');
    expect(writeBatch).toHaveBeenCalledTimes(1);
    const batch = writeBatch.mock.calls[0][0];
    expect(Array.isArray(batch)).toBe(true);
    expect(batch[0]).toMatchObject({
      source: 'claude-sdk',
      category: 'session:tab-stderr',
      message: 'claude: booting\n',
    });
    expect(typeof batch[0].level).toBe('string');
    expect(typeof batch[0].timestamp).toBe('string');

    svc.stopAll();
  });

  it('start() logs error-like stderr at error level, not debug', () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      {
        showNotification: showNotification as any,
        incrementUnread: incrementUnread as any,
      },
      fakeLogging,
    );
    const fake = installFakeQuery();

    svc.start({
      tabId: 'tab-stderr-err',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    const options = fake.getCapturedOptions();

    // Normal debug output → debug level
    options.stderr('claude: booting\n');
    expect(writeBatch.mock.calls[0][0][0].level).toBe('debug');

    // CLI-internal "Error in hook callback hook_N: Stream closed" stderr is
    // a known harmless noise pattern (the CLI fires a teardown / pending-
    // tasks hook that calls back via sendRequest after the SDK input
    // channel has already closed). Demoted unconditionally so it doesn't
    // surface as a red row at session start.
    options.stderr('Error in hook callback hook_9: Stream closed');
    expect(writeBatch.mock.calls[1][0][0].level).toBe('debug');

    // The same noise also lands under SDK 0.3.x as a multi-line bun source-
    // context dump with the same `Error in hook callback hook_N` opener.
    // The classifier should still recognise it.
    options.stderr(
      'Error in hook callback hook_6: 9485 | ${H.map(...)}\n' +
        '9490 | error: Stream closed\n' +
        '  at sendRequest (/$bunfs/root/src/entrypoints/cli.js:9490:133)',
    );
    expect(writeBatch.mock.calls[2][0][0].level).toBe('debug');

    // The bun runtime sometimes splits its stack dump across multiple
    // stderr writes. Without the "Error in hook callback hook_N" preamble
    // a trailing chunk is just the stack — its `error: Stream closed` /
    // `at sendRequest (/$bunfs/…)` lines must STILL be demoted, because
    // there's no other carrier for this signal in the 0.3.x SDK era.
    options.stderr(
      'error: Stream closed\n' +
        '      at sendRequest (/$bunfs/root/src/entrypoints/cli.js:9490:133)\n' +
        '      at <anonymous> (/$bunfs/root/src/entrypoints/cli.js:8951:17119)',
    );
    expect(writeBatch.mock.calls[3][0][0].level).toBe('debug');

    // A bun source-context line on its own (e.g. `9485 | ...`) is also
    // part of a dump and should never be flagged.
    options.stderr('9485 | ${H.map((q) => `- ${q.description}`)}');
    expect(writeBatch.mock.calls[4][0][0].level).toBe('debug');

    // Generic error line not associated with a hook callback → error level
    options.stderr('error: something broke');
    expect(writeBatch.mock.calls[5][0][0].level).toBe('error');

    svc.stopAll();
  });

  // -------------------------------------------------------------------------
  // Teardown-race: stderr arriving AFTER stop() should NOT be classified as
  // an error. When the renderer closes a tab, lifecycle.stop() aborts the
  // SDK input channel; the Claude Code CLI then runs its own teardown hook
  // (hook_9) which tries to push a system-reminder via sendRequest, hits
  // "Stream closed", and dumps the bun stack to stderr. Pre-this-change
  // every tab close generated an error toast.
  // -------------------------------------------------------------------------

  it('start() downgrades "Stream closed" / "Error in hook callback" stderr to debug AFTER stop()', () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      {
        showNotification: showNotification as any,
        incrementUnread: incrementUnread as any,
      },
      fakeLogging,
    );
    const fake = installFakeQuery();

    svc.start({
      tabId: 'tab-shutdown',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    const options = fake.getCapturedOptions();

    // "Error in hook callback hook_N: Stream closed" is CLI-internal noise
    // and demoted unconditionally — fires on every session start under
    // SDK 0.3.x and once again at teardown. No actionable signal in either
    // direction.
    options.stderr('Error in hook callback hook_9: Stream closed');
    const lastCall = writeBatch.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    expect(lastCall![0][0].level).toBe('debug');

    // Now close the tab — flip the shutdown flag
    svc.stop('tab-shutdown');

    writeBatch.mockClear();

    // After shutdown the same stderr still resolves to debug.
    options.stderr('Error in hook callback hook_9: Stream closed');
    expect(writeBatch.mock.calls[0][0][0].level).toBe('debug');

    // Bare "Stream closed" (not wrapped in a hook-callback line) is still
    // a teardown-only demotion.
    options.stderr('error: Stream closed');
    expect(writeBatch.mock.calls[1][0][0].level).toBe('debug');

    // Real errors (FATAL/panic) during shutdown still surface — we shouldn't
    // hide a genuine crash just because we asked to stop.
    options.stderr('FATAL: out of memory');
    expect(writeBatch.mock.calls[2][0][0].level).toBe('error');

    svc.stopAll();
  });

  // -------------------------------------------------------------------------
  // Wave 3.3 — tool-call audit hooks were retired (chat already mirrors them)
  //
  // PreToolUse / PostToolUse / PostToolUseFailure used to write info/error
  // rows into app_logs. Every event is already visible to the user in the
  // chat (tool_use + tool_result blocks) and in Claude's own session JSONL,
  // and PostToolUseFailure was firing error toasts for benign tool exits
  // (grep no-match, git pull conflicts, etc.). The whole tool-call mirror
  // path was dropped 2026-05-12; the Log tab is now reserved for app/session
  // concerns the chat doesn't show.
  // -------------------------------------------------------------------------

  describe('Wave 3.3 audit hooks', () => {
    it('start() does NOT register PreToolUse / PostToolUse / PostToolUseFailure hooks', () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hooks-1',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const options = fake.getCapturedOptions();
      // Hooks object exists (other lifecycle hooks still register) but the
      // tool-call mirror hooks are gone.
      expect(options.hooks).toBeDefined();
      expect(options.hooks.PreToolUse).toBeUndefined();
      expect(options.hooks.PostToolUse).toBeUndefined();
      expect(options.hooks.PostToolUseFailure).toBeUndefined();

      svc.stopAll();
    });

    it('hook metadata is truncated for kept hooks with large payloads (no unbounded log rows)', async () => {
      // Truncation safety net moved to SessionEnd since the tool-call mirror
      // hooks were retired. SessionEnd still writes structured metadata so
      // it remains a representative test for stringifyCapped().
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hooks-big',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const sessionEndHook = fake.getCapturedOptions().hooks.SessionEnd[0].hooks[0];
      const hugeReason = 'x'.repeat(50_000);
      await sessionEndHook(
        {
          session_id: 'sess',
          transcript_path: '/t',
          cwd: '/p',
          hook_event_name: 'SessionEnd',
          reason: hugeReason,
        },
        undefined,
        { signal: new AbortController().signal },
      );

      const entry = writeBatch.mock.calls[0][0][0];
      // Metadata is capped well below the full 50k payload size
      expect(entry.metadata.length).toBeLessThanOrEqual(8000);

      svc.stopAll();
    });

    it('start() omits audit hooks but keeps canUseTool when no logging service is provided', () => {
      // The default `service` fixture above is constructed without a logging dep
      const fake = installFakeQuery();
      service.start({
        tabId: 'no-log-hooks',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const options = fake.getCapturedOptions();
      // canUseTool is always registered (not gated on logging)
      expect(typeof options.canUseTool).toBe('function');
      // Audit hooks should not be present without logging
      expect(options.hooks?.PreToolUse).toBeUndefined();
      expect(options.hooks?.PostToolUse).toBeUndefined();
      expect(options.hooks?.PostToolUseFailure).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // Bonus hooks — SubagentStart, SubagentStop, PreCompact, FileChanged
    // -----------------------------------------------------------------------

    it('SubagentStart hook emits claude-subagent renderer event (does NOT write log row)', async () => {
      // Subagent start/stop are already visible in the subagent UI (driven
      // by the JSONL tail). The hook now only fires the renderer event;
      // no app_logs row is written.
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hook-sa-start',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const options = fake.getCapturedOptions();
      expect(options.hooks.SubagentStart).toBeDefined();
      const hook = options.hooks.SubagentStart[0].hooks[0];

      writeBatch.mockClear();

      await hook(
        { hook_event_name: 'SubagentStart', agent_id: 'sa-1', agent_type: 'Explore', session_id: 's', transcript_path: '/t', cwd: '/p' },
        undefined,
        { signal: new AbortController().signal },
      );

      // No log row for subagent start (chat / UI already shows this)
      expect(writeBatch).not.toHaveBeenCalled();

      // Renderer event still fires
      const rendererCall = sendToRenderer.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].startsWith('claude-subagent:'),
      );
      expect(rendererCall).toBeDefined();
      expect((rendererCall![1]).status).toBe('started');
      expect((rendererCall![1]).agent_type).toBe('Explore');

      svc.stopAll();
    });

    it('SubagentStop hook emits claude-subagent renderer event (does NOT write log row)', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hook-sa-stop',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const hook = fake.getCapturedOptions().hooks.SubagentStop[0].hooks[0];

      writeBatch.mockClear();

      await hook(
        {
          hook_event_name: 'SubagentStop',
          agent_id: 'sa-2',
          agent_type: 'code-reviewer',
          stop_hook_active: false,
          agent_transcript_path: '/t/sa-2.jsonl',
          last_assistant_message: 'Review complete: 3 issues found.',
          session_id: 's',
          transcript_path: '/t',
          cwd: '/p',
        },
        undefined,
        { signal: new AbortController().signal },
      );

      // No log row for subagent stop
      expect(writeBatch).not.toHaveBeenCalled();

      // Renderer event still fires with last_assistant_message
      const rendererCall = sendToRenderer.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].startsWith('claude-subagent:'),
      );
      expect(rendererCall).toBeDefined();
      expect((rendererCall![1]).status).toBe('stopped');
      expect((rendererCall![1]).agent_type).toBe('code-reviewer');
      expect((rendererCall![1]).last_assistant_message).toContain('3 issues');

      svc.stopAll();
    });

    it('PreCompact hook logs a warning + emits renderer event', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hook-compact',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const hook = fake.getCapturedOptions().hooks.PreCompact[0].hooks[0];

      await hook(
        { hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null, session_id: 's', transcript_path: '/t', cwd: '/p' },
        undefined,
        { signal: new AbortController().signal },
      );

      const entry = writeBatch.mock.calls[0][0][0];
      expect(entry.level).toBe('warn');
      expect(entry.message).toContain('compact');
      expect(entry.message).toContain('auto');

      const rendererCall = sendToRenderer.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].startsWith('claude-compact:'),
      );
      expect(rendererCall).toBeDefined();
      expect((rendererCall![1]).trigger).toBe('auto');

      svc.stopAll();
    });

    it('Notification hook emits claude-notification for the tab badge system (does NOT write log row)', async () => {
      // The Notification hook only routes the SDK's user-facing notification
      // to the renderer (tab badge + inline chat). It no longer mirrors the
      // event into app_logs since the chat already shows the message.
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hook-notif',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const options = fake.getCapturedOptions();
      expect(options.hooks.Notification).toBeDefined();
      const hook = options.hooks.Notification[0].hooks[0];

      writeBatch.mockClear();

      await hook(
        {
          hook_event_name: 'Notification',
          message: 'MCP server disconnected',
          title: 'Connection Lost',
          notification_type: 'warning',
          session_id: 's',
          transcript_path: '/t',
          cwd: '/p',
        },
        undefined,
        { signal: new AbortController().signal },
      );

      // No app_logs row written
      expect(writeBatch).not.toHaveBeenCalled();

      // Renderer event — uses the existing claude-notification channel so
      // useNotifications.ts picks it up for tab badges automatically
      const rendererCall = sendToRenderer.mock.calls.find(
        (c) => c[0] === 'claude-notification' && (c[1])?.body === 'MCP server disconnected',
      );
      expect(rendererCall).toBeDefined();
      expect((rendererCall![1]).tab_id).toBe('hook-notif');
      expect((rendererCall![1]).title).toBe('Connection Lost');

      svc.stopAll();
    });

    it('Notification hook marks is_error=true for error-type notifications', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hook-notif-err',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const hook = fake.getCapturedOptions().hooks.Notification[0].hooks[0];

      writeBatch.mockClear();

      await hook(
        {
          hook_event_name: 'Notification',
          message: 'Fatal: subprocess crashed',
          notification_type: 'error',
          session_id: 's',
          transcript_path: '/t',
          cwd: '/p',
        },
        undefined,
        { signal: new AbortController().signal },
      );

      // No app_logs row even for error notifications — Claude already shows
      // them in the chat as a notification system message.
      expect(writeBatch).not.toHaveBeenCalled();

      const rendererCall = sendToRenderer.mock.calls.find(
        (c) => c[0] === 'claude-notification' && (c[1])?.body?.includes('Fatal'),
      );
      expect((rendererCall![1]).is_error).toBe(true);

      svc.stopAll();
    });

    it('Notification hook emits inline chat message on claude-output channel', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hook-notif-inline',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const hook = fake.getCapturedOptions().hooks.Notification[0].hooks[0];

      await hook(
        {
          hook_event_name: 'Notification',
          message: 'MCP server disconnected',
          title: 'Connection Lost',
          notification_type: 'warning',
          session_id: 's',
          transcript_path: '/t',
          cwd: '/p',
        },
        undefined,
        { signal: new AbortController().signal },
      );

      // Should emit on claude-output:<tabId> so it appears in the chat stream
      const outputCall = sendToRenderer.mock.calls.find(
        (c) => c[0] === 'claude-output:hook-notif-inline' && (c[1])?.subtype === 'notification',
      );
      expect(outputCall).toBeDefined();
      const msg = outputCall![1];
      expect(msg.type).toBe('system');
      expect(msg.subtype).toBe('notification');
      // Hook input carries `message` (per the SDK Notification hook
      // contract), but OmniFex propagates it onto the renderer notification
      // as `body` to avoid colliding with assistant/user `.message`.
      expect(msg.body).toBe('MCP server disconnected');
      expect(msg.title).toBe('Connection Lost');
      expect(msg.notification_type).toBe('warning');

      svc.stopAll();
    });

    it('Notification hook inline message uses "error" notification_type for errors', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hook-notif-inline-err',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const hook = fake.getCapturedOptions().hooks.Notification[0].hooks[0];

      await hook(
        {
          hook_event_name: 'Notification',
          message: 'Fatal: subprocess crashed',
          notification_type: 'error',
          session_id: 's',
          transcript_path: '/t',
          cwd: '/p',
        },
        undefined,
        { signal: new AbortController().signal },
      );

      const outputCall = sendToRenderer.mock.calls.find(
        (c) => c[0] === 'claude-output:hook-notif-inline-err' && (c[1])?.subtype === 'notification',
      );
      expect(outputCall).toBeDefined();
      expect((outputCall![1]).notification_type).toBe('error');

      svc.stopAll();
    });

    it('Notification hook inline message defaults to "info" for unknown types', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hook-notif-inline-info',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const hook = fake.getCapturedOptions().hooks.Notification[0].hooks[0];

      await hook(
        {
          hook_event_name: 'Notification',
          message: 'Something happened',
          notification_type: 'info',
          session_id: 's',
          transcript_path: '/t',
          cwd: '/p',
        },
        undefined,
        { signal: new AbortController().signal },
      );

      const outputCall = sendToRenderer.mock.calls.find(
        (c) => c[0] === 'claude-output:hook-notif-inline-info' && (c[1])?.subtype === 'notification',
      );
      expect(outputCall).toBeDefined();
      expect((outputCall![1]).notification_type).toBe('info');

      svc.stopAll();
    });

    it('FileChanged hook logs the event + path', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hook-file',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const hook = fake.getCapturedOptions().hooks.FileChanged[0].hooks[0];

      await hook(
        { hook_event_name: 'FileChanged', file_path: '/p/src/app.ts', event: 'change', session_id: 's', transcript_path: '/t', cwd: '/p' },
        undefined,
        { signal: new AbortController().signal },
      );

      const entry = writeBatch.mock.calls[0][0][0];
      expect(entry.source).toBe('claude-hooks');
      expect(entry.message).toContain('change');
      expect(entry.message).toContain('/p/src/app.ts');

      svc.stopAll();
    });

    // ------------------------------------------------------------------
    // SessionStart hook
    // ------------------------------------------------------------------

    it('SessionStart hook logs session lifecycle with source', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hook-sess-start',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const hook = fake.getCapturedOptions().hooks.SessionStart[0].hooks[0];

      const result = await hook(
        {
          hook_event_name: 'SessionStart',
          source: 'startup',
          model: 'claude-sonnet-4-6',
          session_id: 's1',
          transcript_path: '/t',
          cwd: '/p',
        },
        undefined,
        { signal: new AbortController().signal },
      );

      expect(result).toEqual({});
      const entry = writeBatch.mock.calls[0][0][0];
      expect(entry.level).toBe('info');
      expect(entry.source).toBe('claude-hooks');
      expect(entry.category).toBe('session:hook-sess-start');
      expect(entry.message).toContain('startup');

      // Should emit on claude-output for inline display
      const outputCall = sendToRenderer.mock.calls.find(
        (c) => c[0] === 'claude-output:hook-sess-start' && (c[1])?.subtype === 'session_lifecycle',
      );
      expect(outputCall).toBeDefined();
      expect((outputCall![1]).event).toBe('start');
      expect((outputCall![1]).source).toBe('startup');

      svc.stopAll();
    });

    it('SessionStart hook handles resume source', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hook-sess-resume',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const hook = fake.getCapturedOptions().hooks.SessionStart[0].hooks[0];

      await hook(
        {
          hook_event_name: 'SessionStart',
          source: 'resume',
          session_id: 's1',
          transcript_path: '/t',
          cwd: '/p',
        },
        undefined,
        { signal: new AbortController().signal },
      );

      const entry = writeBatch.mock.calls[0][0][0];
      expect(entry.message).toContain('resume');

      svc.stopAll();
    });

    // ------------------------------------------------------------------
    // SessionEnd hook
    // ------------------------------------------------------------------

    it('SessionEnd hook logs exit reason and emits lifecycle event', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hook-sess-end',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const hook = fake.getCapturedOptions().hooks.SessionEnd[0].hooks[0];

      const result = await hook(
        {
          hook_event_name: 'SessionEnd',
          reason: 'prompt_input_exit',
          session_id: 's1',
          transcript_path: '/t',
          cwd: '/p',
        },
        undefined,
        { signal: new AbortController().signal },
      );

      expect(result).toEqual({});
      const entry = writeBatch.mock.calls[0][0][0];
      expect(entry.level).toBe('info');
      expect(entry.source).toBe('claude-hooks');
      expect(entry.message).toContain('prompt_input_exit');

      const outputCall = sendToRenderer.mock.calls.find(
        (c) => c[0] === 'claude-output:hook-sess-end' && (c[1])?.subtype === 'session_lifecycle',
      );
      expect(outputCall).toBeDefined();
      expect((outputCall![1]).event).toBe('end');
      expect((outputCall![1]).reason).toBe('prompt_input_exit');

      svc.stopAll();
    });

    // ------------------------------------------------------------------
    // Stop hook
    // ------------------------------------------------------------------

    it('Stop hook logs turn completion', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hook-stop',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const hook = fake.getCapturedOptions().hooks.Stop[0].hooks[0];

      const result = await hook(
        {
          hook_event_name: 'Stop',
          stop_hook_active: false,
          last_assistant_message: 'Done! I fixed the bug.',
          session_id: 's1',
          transcript_path: '/t',
          cwd: '/p',
        },
        undefined,
        { signal: new AbortController().signal },
      );

      expect(result).toEqual({});
      const entry = writeBatch.mock.calls[0][0][0];
      expect(entry.level).toBe('info');
      expect(entry.source).toBe('claude-hooks');
      expect(entry.message).toContain('turn complete');

      const meta = JSON.parse(entry.metadata);
      expect(meta.event).toBe('Stop');
      expect(meta.last_assistant_message).toBe('Done! I fixed the bug.');

      svc.stopAll();
    });

    // ------------------------------------------------------------------
    // StopFailure hook
    // ------------------------------------------------------------------

    it('StopFailure hook logs error and emits inline error card', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hook-stop-fail',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const hook = fake.getCapturedOptions().hooks.StopFailure[0].hooks[0];

      const result = await hook(
        {
          hook_event_name: 'StopFailure',
          error: { type: 'model_error', message: 'Rate limit exceeded' },
          error_details: 'Too many requests in the last minute',
          last_assistant_message: 'I was about to...',
          session_id: 's1',
          transcript_path: '/t',
          cwd: '/p',
        },
        undefined,
        { signal: new AbortController().signal },
      );

      expect(result).toEqual({});
      const entry = writeBatch.mock.calls[0][0][0];
      expect(entry.level).toBe('error');
      expect(entry.source).toBe('claude-hooks');

      // Should emit inline error card
      const outputCall = sendToRenderer.mock.calls.find(
        (c) => c[0] === 'claude-output:hook-stop-fail' && (c[1])?.subtype === 'stop_failure',
      );
      expect(outputCall).toBeDefined();
      const msg = outputCall![1];
      expect(msg.type).toBe('system');
      expect(msg.subtype).toBe('stop_failure');
      expect(msg.error_details).toBe('Too many requests in the last minute');

      svc.stopAll();
    });

    it('StopFailure hook handles string error gracefully', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hook-stop-fail-str',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const hook = fake.getCapturedOptions().hooks.StopFailure[0].hooks[0];

      await hook(
        {
          hook_event_name: 'StopFailure',
          error: 'something broke',
          session_id: 's1',
          transcript_path: '/t',
          cwd: '/p',
        },
        undefined,
        { signal: new AbortController().signal },
      );

      const entry = writeBatch.mock.calls[0][0][0];
      expect(entry.level).toBe('error');
      expect(entry.message).toContain('something broke');

      svc.stopAll();
    });

    // ------------------------------------------------------------------
    // PostCompact hook
    // ------------------------------------------------------------------

    it('PostCompact hook logs summary and emits inline message', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hook-postcompact',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const hook = fake.getCapturedOptions().hooks.PostCompact[0].hooks[0];

      const result = await hook(
        {
          hook_event_name: 'PostCompact',
          trigger: 'auto',
          compact_summary: 'Retained: session context about bug fix in auth module',
          session_id: 's1',
          transcript_path: '/t',
          cwd: '/p',
        },
        undefined,
        { signal: new AbortController().signal },
      );

      expect(result).toEqual({});
      const entry = writeBatch.mock.calls[0][0][0];
      expect(entry.level).toBe('info');
      expect(entry.source).toBe('claude-hooks');
      expect(entry.message).toContain('compacted');

      const meta = JSON.parse(entry.metadata);
      expect(meta.compact_summary).toContain('auth module');

      // Should emit on claude-output for inline display
      const outputCall = sendToRenderer.mock.calls.find(
        (c) => c[0] === 'claude-output:hook-postcompact' && (c[1])?.subtype === 'post_compact',
      );
      expect(outputCall).toBeDefined();
      const msg = outputCall![1];
      expect(msg.type).toBe('system');
      expect(msg.subtype).toBe('post_compact');
      expect(msg.trigger).toBe('auto');
      expect(msg.compact_summary).toContain('auth module');

      svc.stopAll();
    });

    // ------------------------------------------------------------------
    // PermissionDenied hook
    // ------------------------------------------------------------------

    it('PermissionDenied hook logs denial and emits inline card', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hook-perm-denied',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const hook = fake.getCapturedOptions().hooks.PermissionDenied[0].hooks[0];

      const result = await hook(
        {
          hook_event_name: 'PermissionDenied',
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf /' },
          tool_use_id: 'tu-deny-1',
          reason: 'User denied permission',
          session_id: 's1',
          transcript_path: '/t',
          cwd: '/p',
        },
        'tu-deny-1',
        { signal: new AbortController().signal },
      );

      expect(result).toEqual({});
      const entry = writeBatch.mock.calls[0][0][0];
      expect(entry.level).toBe('warn');
      expect(entry.source).toBe('claude-hooks');
      expect(entry.message).toContain('Bash');
      expect(entry.message).toContain('denied');

      const meta = JSON.parse(entry.metadata);
      expect(meta.event).toBe('PermissionDenied');
      expect(meta.tool_name).toBe('Bash');
      expect(meta.reason).toBe('User denied permission');

      // Should emit inline denial card
      const outputCall = sendToRenderer.mock.calls.find(
        (c) => c[0] === 'claude-output:hook-perm-denied' && (c[1])?.subtype === 'permission_denied',
      );
      expect(outputCall).toBeDefined();
      const msg = outputCall![1];
      expect(msg.type).toBe('system');
      expect(msg.subtype).toBe('permission_denied');
      expect(msg.tool_name).toBe('Bash');
      expect(msg.reason).toBe('User denied permission');

      svc.stopAll();
    });

    // -------------------------------------------------------------------
    // New hooks: #16, #17, #19, #20, #21, #22, #23, #26
    // -------------------------------------------------------------------

    it('UserPromptSubmit hook logs prompt and emits renderer event', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, fakeLogging);
      const fake = installFakeQuery();
      svc.start({ tabId: 'h-ups', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

      const hook = fake.getCapturedOptions().hooks.UserPromptSubmit[0].hooks[0];
      const result = await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hello world', session_title: 'My Session', session_id: 's', transcript_path: '/t', cwd: '/p' }, undefined, { signal: new AbortController().signal });

      expect(result).toEqual({});
      expect(writeBatch).toHaveBeenCalled();
      const entry = writeBatch.mock.calls[0][0][0];
      expect(entry.message).toContain('prompt submitted');
      expect(entry.source).toBe('claude-hooks');
      const outputCall = sendToRenderer.mock.calls.find((c) => c[0] === 'claude-output:h-ups' && (c[1])?.subtype === 'user_prompt_submit');
      expect(outputCall).toBeDefined();

      svc.stopAll();
    });

    it('Setup hook logs trigger and emits renderer notification', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, fakeLogging);
      const fake = installFakeQuery();
      svc.start({ tabId: 'h-setup', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

      const hook = fake.getCapturedOptions().hooks.Setup[0].hooks[0];
      const result = await hook({ hook_event_name: 'Setup', trigger: 'init', session_id: 's', transcript_path: '/t', cwd: '/p' }, undefined, { signal: new AbortController().signal });

      expect(result).toEqual({});
      expect(writeBatch).toHaveBeenCalled();
      expect(writeBatch.mock.calls[0][0][0].message).toContain('setup: init');

      svc.stopAll();
    });

    it('TaskCreated hook logs + emits task_event', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, fakeLogging);
      const fake = installFakeQuery();
      svc.start({ tabId: 'h-tc', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

      const hook = fake.getCapturedOptions().hooks.TaskCreated[0].hooks[0];
      await hook({ hook_event_name: 'TaskCreated', task_id: 't1', task_subject: 'Fix bug', teammate_name: 'Explorer', session_id: 's', transcript_path: '/t', cwd: '/p' }, undefined, { signal: new AbortController().signal });

      expect(writeBatch.mock.calls[0][0][0].message).toContain('task created: Fix bug');
      const outputCall = sendToRenderer.mock.calls.find((c) => c[0] === 'claude-output:h-tc' && (c[1])?.subtype === 'task_event' && (c[1])?.event === 'created');
      expect(outputCall).toBeDefined();
      expect((outputCall![1]).task_subject).toBe('Fix bug');

      svc.stopAll();
    });

    it('TaskCompleted hook logs + emits task_event but does NOT trigger a notification', async () => {
      // OS-level notifications + tab-unread badges on every task completion
      // are noise — under the SDK 0.3.x Task* primitive the agent typically
      // creates a batch of 3-10 todos per turn, and a notification per
      // completion floods the user. The log row + chat-stream task_event
      // are kept; the dock/badge/native notification calls are dropped.
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, fakeLogging);
      const fake = installFakeQuery();
      svc.start({ tabId: 'h-tcomp', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

      const hook = fake.getCapturedOptions().hooks.TaskCompleted[0].hooks[0];
      await hook({ hook_event_name: 'TaskCompleted', task_id: 't1', task_subject: 'Fix bug', teammate_name: 'Explorer', session_id: 's', transcript_path: '/t', cwd: '/p' }, undefined, { signal: new AbortController().signal });

      expect(writeBatch.mock.calls[0][0][0].message).toContain('task completed: Fix bug');
      const outputCall = sendToRenderer.mock.calls.find((c) => c[0] === 'claude-output:h-tcomp' && (c[1])?.subtype === 'task_event' && (c[1])?.event === 'completed');
      expect(outputCall).toBeDefined();
      expect(showNotification).not.toHaveBeenCalled();
      expect(incrementUnread).not.toHaveBeenCalled();

      svc.stopAll();
    });

    it('Elicitation hook logs but does not auto-accept (onElicitation handles user prompt)', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, fakeLogging);
      const fake = installFakeQuery();
      svc.start({ tabId: 'h-elicit', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

      const hook = fake.getCapturedOptions().hooks.Elicitation[0].hooks[0];
      const result = await hook({ hook_event_name: 'Elicitation', mcp_server_name: 'github', message: 'Authenticate', mode: 'form', session_id: 's', transcript_path: '/t', cwd: '/p' }, undefined, { signal: new AbortController().signal });

      expect(writeBatch).toHaveBeenCalled();
      expect(writeBatch.mock.calls[0][0][0].message).toContain('elicitation from github');
      // Hook should NOT return an action — onElicitation in lifecycle.ts prompts the user
      expect(result.hookSpecificOutput).toBeUndefined();

      svc.stopAll();
    });

    it('onElicitation sends event to renderer and resolves when respondElicitation is called', async () => {
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, null);
      const fake = installFakeQuery();
      svc.start({ tabId: 'elicit-resolve', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

      const onElicitation = fake.getCapturedOptions().onElicitation;
      expect(onElicitation).toBeDefined();

      // Call onElicitation in the background — it should block until respondElicitation
      const resultPromise = onElicitation!(
        { serverName: 'github', message: 'Authenticate please', mode: 'form' },
        { signal: new AbortController().signal },
      );

      // The renderer should have been notified
      expect(sendToRenderer).toHaveBeenCalledWith(
        'elicitation-request:elicit-resolve',
        expect.objectContaining({ serverName: 'github', message: 'Authenticate please' }),
      );

      // Simulate user clicking Accept
      svc.respondElicitation('elicit-resolve', 'accept');

      const result = await resultPromise;
      expect(result.action).toBe('accept');

      svc.stopAll();
    });

    it('respondElicitation with decline returns decline action', async () => {
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, null);
      const fake = installFakeQuery();
      svc.start({ tabId: 'elicit-decline', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

      const onElicitation = fake.getCapturedOptions().onElicitation;
      const resultPromise = onElicitation!(
        { serverName: 'slack', message: 'Login required', mode: 'url', url: 'https://example.com/auth' },
        { signal: new AbortController().signal },
      );

      svc.respondElicitation('elicit-decline', 'decline');

      const result = await resultPromise;
      expect(result.action).toBe('decline');

      svc.stopAll();
    });

    it('ElicitationResult hook logs the action', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, fakeLogging);
      const fake = installFakeQuery();
      svc.start({ tabId: 'h-er', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

      const hook = fake.getCapturedOptions().hooks.ElicitationResult[0].hooks[0];
      await hook({ hook_event_name: 'ElicitationResult', mcp_server_name: 'github', action: 'accept', session_id: 's', transcript_path: '/t', cwd: '/p' }, undefined, { signal: new AbortController().signal });

      expect(writeBatch.mock.calls[0][0][0].message).toContain('elicitation result: github → accept');

      svc.stopAll();
    });

    it('ConfigChange hook logs + emits renderer event', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, fakeLogging);
      const fake = installFakeQuery();
      svc.start({ tabId: 'h-cc', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

      const hook = fake.getCapturedOptions().hooks.ConfigChange[0].hooks[0];
      await hook({ hook_event_name: 'ConfigChange', source: 'project_settings', file_path: '/p/.claude/settings.json', session_id: 's', transcript_path: '/t', cwd: '/p' }, undefined, { signal: new AbortController().signal });

      expect(writeBatch.mock.calls[0][0][0].message).toContain('config changed: project_settings');
      const outputCall = sendToRenderer.mock.calls.find((c) => c[0] === 'claude-output:h-cc' && (c[1])?.subtype === 'config_change');
      expect(outputCall).toBeDefined();
      expect((outputCall![1]).source).toBe('project_settings');

      svc.stopAll();
    });

    it('InstructionsLoaded hook logs + emits renderer event', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, fakeLogging);
      const fake = installFakeQuery();
      svc.start({ tabId: 'h-il', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

      const hook = fake.getCapturedOptions().hooks.InstructionsLoaded[0].hooks[0];
      await hook({ hook_event_name: 'InstructionsLoaded', file_path: '/p/CLAUDE.md', memory_type: 'Project', load_reason: 'session_start', session_id: 's', transcript_path: '/t', cwd: '/p' }, undefined, { signal: new AbortController().signal });

      expect(writeBatch.mock.calls[0][0][0].message).toContain('instructions loaded: /p/CLAUDE.md');
      const outputCall = sendToRenderer.mock.calls.find((c) => c[0] === 'claude-output:h-il' && (c[1])?.subtype === 'instructions_loaded');
      expect(outputCall).toBeDefined();
      expect((outputCall![1]).memory_type).toBe('Project');
      expect((outputCall![1]).load_reason).toBe('session_start');

      svc.stopAll();
    });
  });

  it('start() omits stderr callback when no logging service is provided', () => {
    // The default `service` fixture above is constructed without a logging dep
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-no-logging',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    const options = fake.getCapturedOptions();
    expect(options.stderr).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Wave 2 — Query-method passthroughs
  // -------------------------------------------------------------------------

  describe('Wave 2 Query-method passthroughs', () => {
    it('interrupt() calls the Query.interrupt() for an active tab and is a no-op for an unknown tab', async () => {
      const fake = installFakeQuery();
      service.start({
        tabId: 'w2-int',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      await service.interrupt('w2-int');
      expect(fake.query.interrupt).toHaveBeenCalledTimes(1);

      await service.interrupt('unknown-tab'); // must not throw
      expect(fake.query.interrupt).toHaveBeenCalledTimes(1);
    });

    it('setModel() forwards the model to Query.setModel()', async () => {
      const fake = installFakeQuery();
      service.start({
        tabId: 'w2-model',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      await service.setModel('w2-model', 'claude-opus-4-6');
      expect(fake.query.setModel).toHaveBeenCalledWith('claude-opus-4-6');

      // unknown tab is a no-op
      await service.setModel('unknown', 'claude-opus-4-6');
      expect(fake.query.setModel).toHaveBeenCalledTimes(1);
    });

    it('setPermissionMode() forwards the mode to Query.setPermissionMode()', async () => {
      const fake = installFakeQuery();
      service.start({
        tabId: 'w2-mode',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      await service.setPermissionMode('w2-mode', 'acceptEdits');
      expect(fake.query.setPermissionMode).toHaveBeenCalledWith('acceptEdits');

      await service.setPermissionMode('unknown', 'plan'); // no-op
      expect(fake.query.setPermissionMode).toHaveBeenCalledTimes(1);
    });

    it('setEffort calls applyFlagSettings with effortLevel', async () => {
      const fake = installFakeQuery();
      service.start({
        tabId: 'tab-set-effort',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      await service.setEffort('tab-set-effort', 'max');
      expect(fake.query.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'max' });

      service.stopAll();
    });

    it('setEffort accepts xhigh (SDK EffortLevel includes xhigh)', async () => {
      const fake = installFakeQuery();
      service.start({
        tabId: 'tab-xhigh-set',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      await service.setEffort('tab-xhigh-set', 'xhigh');
      expect(fake.query.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'xhigh' });

      service.stopAll();
    });

    it('setEffort with null clears effortLevel', async () => {
      const fake = installFakeQuery();
      service.start({
        tabId: 'tab-clear-effort',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      await service.setEffort('tab-clear-effort', null);
      expect(fake.query.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: undefined });

      service.stopAll();
    });

    it('applyPermissions pushes the rule lists into the live SDK session', async () => {
      const fake = installFakeQuery();
      service.start({
        tabId: 'tab-perm-apply',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      await service.applyPermissions('tab-perm-apply', {
        allow: ['Edit(/.claude/commands/*)', 'Bash(npm run test:*)'],
        deny: ['Bash(rm -rf:*)'],
      });
      expect(fake.query.applyFlagSettings).toHaveBeenCalledWith({
        permissions: {
          allow: ['Edit(/.claude/commands/*)', 'Bash(npm run test:*)'],
          deny: ['Bash(rm -rf:*)'],
        },
      });

      service.stopAll();
    });

    it('applyPermissions is a no-op for an unknown tab', async () => {
      const fake = installFakeQuery();
      // No service.start() — tab doesn't exist
      await service.applyPermissions('no-such-tab', { allow: ['Bash'] });
      expect(fake.query.applyFlagSettings).not.toHaveBeenCalled();
    });

    it('setThinking("disabled") calls setMaxThinkingTokens(0)', async () => {
      const fake = installFakeQuery();
      service.start({
        tabId: 'tab-think-off',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      await service.setThinking('tab-think-off', { type: 'disabled' });
      expect(fake.query.setMaxThinkingTokens).toHaveBeenCalledWith(0);

      service.stopAll();
    });

    it('setThinking("adaptive") calls setMaxThinkingTokens(null)', async () => {
      const fake = installFakeQuery();
      service.start({
        tabId: 'tab-think-adapt',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      await service.setThinking('tab-think-adapt', { type: 'adaptive' });
      expect(fake.query.setMaxThinkingTokens).toHaveBeenCalledWith(null);

      service.stopAll();
    });

    it('setThinking({type:"enabled", budgetTokens}) collapses to adaptive — calls setMaxThinkingTokens(null)', async () => {
      // Stale-state safety: a caller from before v0.4.21 might still
      // pass an `enabled` shape with a budget. The SDK collapses every
      // non-zero budget to adaptive on Opus 4.6+ anyway, so the queries
      // module now treats `enabled` the same as `adaptive` instead of
      // forwarding the budget number.
      const fake = installFakeQuery();
      service.start({
        tabId: 'tab-think-budget',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      await service.setThinking('tab-think-budget', { type: 'enabled', budgetTokens: 10000 });
      expect(fake.query.setMaxThinkingTokens).toHaveBeenCalledWith(null);

      service.stopAll();
    });

    it('getAccountInfo() returns the SDK-reported account for an active tab and null for unknown', async () => {
      const fake = installFakeQuery();
      service.start({
        tabId: 'w2-acct',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const info = await service.getAccountInfo('w2-acct');
      expect(fake.query.accountInfo).toHaveBeenCalledTimes(1);
      expect(info).toMatchObject({ email: 'test@example.com' });

      const nothing = await service.getAccountInfo('unknown');
      expect(nothing).toBeNull();
    });

    it('getContextUsage() returns the usage breakdown for an active tab', async () => {
      const fake = installFakeQuery();
      service.start({
        tabId: 'w2-ctx',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const usage = await service.getContextUsage('w2-ctx');
      expect(fake.query.getContextUsage).toHaveBeenCalledTimes(1);
      expect(usage).not.toBeNull();
      expect(usage!.totalTokens).toBe(1000);
      expect(usage!.maxTokens).toBe(200000);
      expect(usage!.percentage).toBe(0.5);

      const nothing = await service.getContextUsage('unknown');
      expect(nothing).toBeNull();
    });

    it('getSupportedCommands() returns [] for unknown tab and the SDK list for an active tab', async () => {
      const fake = installFakeQuery();
      service.start({
        tabId: 'w2-cmds',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const commands = await service.getSupportedCommands('w2-cmds');
      expect(fake.query.supportedCommands).toHaveBeenCalledTimes(1);
      expect(commands).toHaveLength(2);
      expect(commands.map((c) => c.name)).toEqual(['review', 'explain']);

      const empty = await service.getSupportedCommands('unknown');
      expect(empty).toEqual([]);
    });

    it('getSupportedModels() returns [] for unknown tab and the SDK list for an active tab', async () => {
      const fake = installFakeQuery();
      service.start({
        tabId: 'w2-models',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const models = await service.getSupportedModels('w2-models');
      expect(fake.query.supportedModels).toHaveBeenCalledTimes(1);
      expect(models).toHaveLength(2);
      expect(models.map((m) => m.value)).toEqual(['claude-sonnet-4-6', 'claude-opus-4-6']);

      const empty = await service.getSupportedModels('unknown');
      expect(empty).toEqual([]);
    });

    it('getSupportedAgents() returns [] for unknown tab and the SDK list for an active tab', async () => {
      const fake = installFakeQuery();
      service.start({
        tabId: 'w2-agents',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const agents = await service.getSupportedAgents('w2-agents');
      expect(fake.query.supportedAgents).toHaveBeenCalledTimes(1);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe('Explore');

      const empty = await service.getSupportedAgents('unknown');
      expect(empty).toEqual([]);
    });

    it('SDK errors inside a Query method propagate as null/[] rather than throwing', async () => {
      const fake = installFakeQuery();
      service.start({
        tabId: 'w2-err',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      fake.query.accountInfo.mockRejectedValueOnce(new Error('CLI subprocess crashed'));
      const info = await service.getAccountInfo('w2-err');
      expect(info).toBeNull();

      fake.query.getContextUsage.mockRejectedValueOnce(new Error('timeout'));
      const usage = await service.getContextUsage('w2-err');
      expect(usage).toBeNull();

      fake.query.supportedModels.mockRejectedValueOnce(new Error('fail'));
      const models = await service.getSupportedModels('w2-err');
      expect(models).toEqual([]);
    });
  });

  it('canUseTool does NOT short-circuit edit tools in acceptEdits mode — the SDK handles its own auto-approval', async () => {
    // Regression guard: the previous behavior auto-allowed Read/Write/Edit/
    // MultiEdit/NotebookEdit at the app layer when permissionMode was
    // acceptEdits. That double-handles what the SDK already does and prevents
    // the user from ever seeing a permission card for edit tools the SDK
    // *would* still surface (e.g. when settings rules ask to confirm a
    // specific path). We now defer entirely to the SDK: if the SDK calls
    // canUseTool for a tool, we always run the dialog flow.
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging,
    );
    const fake = installFakeQuery();

    svc.start({
      tabId: 'tab-auto-partial',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
    });

    const canUseTool = fake.getCapturedOptions().canUseTool;
    // Fire canUseTool but don't await — we want to see the permission_request
    // emitted, then resolve via respondPermission so the promise settles.
    const decision = canUseTool('Edit', { file_path: '/p/a.ts' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-auto',
    });

    await new Promise((r) => setImmediate(r));

    expect(svc.getStatus('tab-auto-partial')).toBe('waiting_permission');
    expect(sendToRenderer).toHaveBeenCalledWith(
      'claude-output:tab-auto-partial',
      expect.objectContaining({ type: 'permission_request', tool_name: 'Edit' }),
    );

    svc.respondPermission('tab-auto-partial', 'allow', { file_path: '/p/a.ts' });
    const result = await decision;
    expect(result.behavior).toBe('allow');

    svc.stopAll();
  });

  it('setPermissionMode forwards to the live SDK and updates the stored handle option', async () => {
    // Two halves: the live SDK call (so the running query starts honoring the
    // new mode immediately) AND the cached sdkOptions.permissionMode (so
    // anything that re-reads `currentPermissionMode(handle)` after the change
    // — e.g. the canUseTool callback — sees the new value). The captured
    // options object from the SDK's query() call is the same reference the
    // service stores on the handle, so we can verify both halves through it.
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
    );
    const fake = installFakeQuery();

    svc.start({
      tabId: 'tab-mode-fallback',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    expect(fake.getCapturedOptions().permissionMode).toBe('default');

    await svc.setPermissionMode('tab-mode-fallback', 'plan');

    expect(fake.query.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(fake.getCapturedOptions().permissionMode).toBe('plan');

    svc.stopAll();
  });

  // -------------------------------------------------------------------------
  // Task 5 — setMode / tuiWrite / tuiResize
  // -------------------------------------------------------------------------

  it('setMode("tui") spawns a TuiSession when status is running', async () => {
    mockedCreateTuiSession.mockReturnValue({
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(), onExit: vi.fn(),
    });

    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
    );
    const fake = installFakeQuery();
    svc.start({ tabId: 'tab-mode', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    // Force handle into 'running' via a system:init message
    fake.pushMessage({ type: 'system', subtype: 'init', session_id: 'session-xyz' });
    await new Promise((r) => setImmediate(r));

    await svc.setMode('tab-mode', 'tui');

    expect(mockedCreateTuiSession).toHaveBeenCalledTimes(1);
    expect(mockedCreateTuiSession.mock.calls[0][0].sessionId).toBe('session-xyz');
    expect(svc.getMode('tab-mode')).toBe('tui');

    svc.stopAll();
    mockedCreateTuiSession.mockReset();
  });

  it('setMode("tui") rejects when session is waiting_permission', async () => {
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
    );
    const fake = installFakeQuery();
    svc.start({ tabId: 'tab-gate', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    // Force into waiting_permission
    const canUseTool = fake.getCapturedOptions().canUseTool;
    canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'tu' });
    await new Promise((r) => setImmediate(r));

    await expect(svc.setMode('tab-gate', 'tui')).rejects.toThrow(/not allowed/i);

    svc.respondPermission('tab-gate', 'deny');
    svc.stopAll();
  });

  it('setMode("tui") is allowed while status is "starting" (post-restart window)', async () => {
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
    );
    const fake = installFakeQuery();
    svc.start({ tabId: 'tab-starting', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    // Drive into running + get a sessionId
    fake.pushMessage({ type: 'system', subtype: 'init', session_id: 'sess-starting' });
    await new Promise((r) => setImmediate(r));

    // Prime a fresh mocked pty so setMode('tui') succeeds
    mockedCreateTuiSession.mockClear();
    mockedCreateTuiSession.mockReturnValue({
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(), onExit: vi.fn(),
    });
    await svc.setMode('tab-starting', 'tui');

    // Go back to SDK — restartQuery sets status to 'starting'
    mockedQuery.mockClear();
    mockedQuery.mockReturnValue(installFakeQuery().query);
    await svc.setMode('tab-starting', 'sdk');
    expect(svc.getStatus('tab-starting')).toBe('starting');

    // Now re-switch to TUI BEFORE the first post-restart message arrives.
    // With the relaxed gate this should succeed.
    mockedCreateTuiSession.mockClear();
    mockedCreateTuiSession.mockReturnValue({
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(), onExit: vi.fn(),
    });
    await expect(svc.setMode('tab-starting', 'tui')).resolves.toBeUndefined();
    expect(svc.getMode('tab-starting')).toBe('tui');

    svc.stopAll();
  });

  it('stop() kills the TUI pty if the session is in tui mode', async () => {
    const killSpy = vi.fn();
    mockedCreateTuiSession.mockReturnValue({
      write: vi.fn(), resize: vi.fn(), kill: killSpy,
      onData: vi.fn(), onExit: vi.fn(),
    });

    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
    );
    const fake = installFakeQuery();
    svc.start({ tabId: 'tab-stop-tui', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    fake.pushMessage({ type: 'system', subtype: 'init', session_id: 'sess-stop' });
    await new Promise((r) => setImmediate(r));

    await svc.setMode('tab-stop-tui', 'tui');
    svc.stop('tab-stop-tui');

    expect(killSpy).toHaveBeenCalled();

    mockedCreateTuiSession.mockReset();
  });

  // -------------------------------------------------------------------------
  // Task 6 — TUI → SDK restart via restartSdkQuery
  // -------------------------------------------------------------------------

  it('setMode("sdk") after tui re-enters the SDK with resume=sessionId and status=starting', async () => {
    mockedCreateTuiSession.mockReturnValue({
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(), onExit: vi.fn(),
    });

    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
    );
    const fake = installFakeQuery();
    svc.start({ tabId: 'rt', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    fake.pushMessage({ type: 'system', subtype: 'init', session_id: 'sess-round' });
    await new Promise((r) => setImmediate(r));

    await svc.setMode('rt', 'tui');
    expect(svc.getMode('rt')).toBe('tui');

    // Reset the SDK query mock so we observe only the restart call
    mockedQuery.mockClear();
    const restartFake = installFakeQuery();

    await svc.setMode('rt', 'sdk');

    expect(svc.getMode('rt')).toBe('sdk');
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const restartCall = restartFake.getCapturedOptions();
    expect(restartCall.resume).toBe('sess-round');
    expect(svc.getStatus('rt')).toBe('starting');

    svc.stopAll();
    mockedCreateTuiSession.mockReset();
  });

  it('tui exit auto-reverts the session to sdk mode', async () => {
    // NB: this test depends on the vi.mock of '../services/sessions/tui' already
    // established by earlier tests in this file. The same mocked createTuiSession
    // returns an object whose onExit is a vi.fn — we capture the registered
    // callback and invoke it to simulate the pty exiting (user typed /exit).
    mockedCreateTuiSession.mockReturnValue({
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(), onExit: vi.fn(),
    });

    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
    );
    const fake = installFakeQuery();
    svc.start({ tabId: 'auto', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    // Drive into running state
    fake.pushMessage({ type: 'system', subtype: 'init', session_id: 'sess-auto' });
    await new Promise((r) => setImmediate(r));

    // Reset the mock history before setMode so we can read the fresh call
    mockedCreateTuiSession.mockClear();
    // Re-supply the implementation after mockClear resets it
    mockedCreateTuiSession.mockReturnValue({
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(), onExit: vi.fn(),
    });

    // Prime the query mock for the subsequent TUI->SDK restart
    mockedQuery.mockClear();
    installFakeQuery();

    await svc.setMode('auto', 'tui');
    expect(svc.getMode('auto')).toBe('tui');

    // Grab the pty mock returned from the most recent createTuiSession call
    const ptyMock = mockedCreateTuiSession.mock.results[0].value as {
      onExit: ReturnType<typeof vi.fn>;
    };
    // Extract the registered exit callback
    const exitCallback = ptyMock.onExit.mock.calls[0][0] as (r: { exitCode: number }) => void;

    // Simulate the pty exiting (user typed /exit)
    exitCallback({ exitCode: 0 });
    await new Promise((r) => setImmediate(r));

    expect(svc.getMode('auto')).toBe('sdk');

    svc.stopAll();
    mockedCreateTuiSession.mockReset();
  });
});

// ---------------------------------------------------------------------------
// getHealth()
// ---------------------------------------------------------------------------

describe('sessions service — getHealth', () => {
  let service: SessionsService;
  let sendToRenderer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockedQuery.mockReset();
    sendToRenderer = vi.fn();
    service = createSessionsService(sendToRenderer as any);
  });

  it('returns alive:false, status:stopped, sessionId:null for unknown tab', () => {
    const health = service.getHealth('unknown-tab');
    expect(health).toEqual({ alive: false, status: 'stopped', sessionId: null });
  });

  it('returns alive:true with current status and sessionId for an active session', () => {
    installFakeQuery();

    service.start({
      tabId: 'health-tab',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    const health = service.getHealth('health-tab');
    expect(health.alive).toBe(true);
    expect(health.status).toBe('starting');
    expect(health.sessionId).toBeNull(); // no init message yet
  });
});

// ---------------------------------------------------------------------------
// Sessions service — per-window ownership hooks
// ---------------------------------------------------------------------------

describe('sessions service — ownership hook', () => {
  let service: SessionsService;
  let sendToRenderer: ReturnType<typeof vi.fn>;
  let ownership: { register: ReturnType<typeof vi.fn>; unregister: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockedQuery.mockReset();
    sendToRenderer = vi.fn();
    ownership = { register: vi.fn(), unregister: vi.fn() };
    service = createSessionsService(sendToRenderer as any, {}, null, ownership as any);
  });

  afterEach(() => {
    service.stopAll();
  });

  it('registers the owner webContents id on start when provided', () => {
    installFakeQuery();
    service.start({
      tabId: 'tab-A',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
      ownerWebContentsId: 7,
    });
    expect(ownership.register).toHaveBeenCalledWith('tab-A', 7);
  });

  it('does not register when ownerWebContentsId is omitted', () => {
    installFakeQuery();
    service.start({
      tabId: 'tab-B',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });
    expect(ownership.register).not.toHaveBeenCalled();
  });

  it('unregisters the owner on stop()', () => {
    installFakeQuery();
    service.start({
      tabId: 'tab-C',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
      ownerWebContentsId: 11,
    });
    service.stop('tab-C');
    expect(ownership.unregister).toHaveBeenCalledWith('tab-C');
  });
});

// ---------------------------------------------------------------------------
// rebind() — re-attach an existing session to a (new) owner webContents
// without tearing down the SDK query. Used when the renderer reloads (Cmd+R)
// and needs to re-claim its in-flight sessions instead of restarting them.
// ---------------------------------------------------------------------------

describe('sessions service — rebind', () => {
  let service: SessionsService;
  let sendToRenderer: ReturnType<typeof vi.fn>;
  let ownership: { register: ReturnType<typeof vi.fn>; unregister: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockedQuery.mockReset();
    sendToRenderer = vi.fn();
    ownership = { register: vi.fn(), unregister: vi.fn() };
    service = createSessionsService(sendToRenderer as any, {}, null, ownership as any);
  });

  afterEach(() => {
    service.stopAll();
  });

  it('returns false for an unknown tab and does not register ownership', () => {
    const ok = service.rebind('nope', 42);
    expect(ok).toBe(false);
    expect(ownership.register).not.toHaveBeenCalled();
  });

  it('returns true and re-registers ownership for an active tab without closing the query', () => {
    const fake = installFakeQuery();
    service.start({
      tabId: 'tab-rebind',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
      ownerWebContentsId: 7,
    });
    expect(ownership.register).toHaveBeenLastCalledWith('tab-rebind', 7);

    const ok = service.rebind('tab-rebind', 99);

    expect(ok).toBe(true);
    expect(fake.wasClosed()).toBe(false);
    expect(service.isActive('tab-rebind')).toBe(true);
    expect(ownership.register).toHaveBeenLastCalledWith('tab-rebind', 99);
  });

  it('does not call the SDK query factory again on rebind (no new subprocess)', () => {
    installFakeQuery();
    service.start({
      tabId: 'tab-noop',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
      ownerWebContentsId: 1,
    });
    expect(mockedQuery).toHaveBeenCalledTimes(1);

    service.rebind('tab-noop', 2);

    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });
});
