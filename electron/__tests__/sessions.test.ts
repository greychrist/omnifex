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

const mockedQuery = vi.mocked(sdkQuery);

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

  it('sendMessage / sendStructuredMessage / respondPermission / stop / setAutoAllow / addAutoAllowTool are no-ops for unknown tabs', () => {
    expect(() => service.sendMessage('unknown', 'hi')).not.toThrow();
    expect(() => service.sendStructuredMessage('unknown', [])).not.toThrow();
    expect(() => service.respondPermission('unknown', 'allow')).not.toThrow();
    expect(() => service.stop('unknown')).not.toThrow();
    expect(() => service.setAutoAllow('unknown', true)).not.toThrow();
    expect(() => service.addAutoAllowTool('unknown', 'Bash')).not.toThrow();
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
    expect(service.getStatus('tab-init')).toBe('running');
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
    // Keep the channel referenced so TS doesn't complain about the unused var
    channel.close();
  });

  it('recovers from stream error when user sends a new message', async () => {
    // First query: throw immediately
    let callCount = 0;
    const errorChannel = createAsyncChannel<unknown>();
    const errorQuery: any = {
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

    mockedQuery.mockImplementation((args: any) => {
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
    expect((next.value as any).type).toBe('user');
    expect((next.value as any).message.content).toBe('hello, world');
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
    expect((next.value as any).type).toBe('user');
    expect(Array.isArray((next.value as any).message.content)).toBe(true);
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
      fakeLogging as any,
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
      (c) => c[0] === 'claude-output:tab-perm' && (c[1] as any)?.type === 'permission_request',
    );
    expect(permCall).toBeDefined();
    expect((permCall![1] as any).tool_name).toBe('Bash');
    expect((permCall![1] as any).tool_input).toEqual({ command: 'ls -la' });
    expect((permCall![1] as any).title).toBe('Run ls -la');

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
      fakeLogging as any,
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

    // Should fire native notification for the permission request
    expect(showNotification).toHaveBeenCalledWith(
      expect.stringContaining('my-project'),
      expect.stringContaining('Bash'),
      false,
      { tabId: 'tab-perm-notif' },
    );
    expect(incrementUnread).toHaveBeenCalled();

    // Clean up — resolve the permission so the promise settles
    svc.respondPermission('tab-perm-notif', 'deny');
    await decisionPromise;
    svc.stopAll();
  });

  it('canUseTool resolves to allow without updatedInput when none provided', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging as any,
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
      fakeLogging as any,
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

  it('canUseTool passes through updatedPermissions for "allow & remember"', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging as any,
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
    expect(result.updatedPermissions).toEqual(rules);

    svc.stopAll();
  });

  it('canUseTool forwards suggestions and rich metadata to the renderer', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging as any,
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
      (c) => c[0] === 'claude-output:tab-sug' && (c[1] as any)?.type === 'permission_request',
    );
    expect(permCall).toBeDefined();
    expect((permCall![1] as any).permission_suggestions).toEqual(suggestions);
    expect((permCall![1] as any).title).toBe('Run git status');
    expect((permCall![1] as any).display_name).toBe('Bash');
    expect((permCall![1] as any).description).toBe('Execute a shell command');

    svc.respondPermission('tab-sug', 'allow');
    await decisionPromise;

    svc.stopAll();
  });

  it('permission queue emits the next payload to the renderer after the first resolves', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging as any,
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
      (c) => c[0] === 'claude-output:tab-queue' && (c[1] as any)?.type === 'permission_request',
    );
    expect(permRequests.length).toBe(1);
    expect((permRequests[0][1] as any).tool_name).toBe('Bash');

    // Resolve the first — the second should now be emitted to the renderer.
    svc.respondPermission('tab-queue', 'allow');
    await firstPromise;

    const permRequestsAfter = sendToRenderer.mock.calls.filter(
      (c) => c[0] === 'claude-output:tab-queue' && (c[1] as any)?.type === 'permission_request',
    );
    expect(permRequestsAfter.length).toBe(2);
    expect((permRequestsAfter[1][1] as any).tool_name).toBe('Write');

    // A second notification should have fired for the queued request.
    expect(showNotification.mock.calls.length).toBeGreaterThanOrEqual(2);

    svc.respondPermission('tab-queue', 'deny');
    await secondPromise;
    svc.stopAll();
  });

  it('setAutoAllow / addAutoAllowTool mutate the session handle state', () => {
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
    );
    installFakeQuery();
    svc.start({ tabId: 'tab-auto', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    // No-ops that shouldn't throw even after state changes.
    expect(() => svc.setAutoAllow('tab-auto', true)).not.toThrow();
    expect(() => svc.addAutoAllowTool('tab-auto', 'Bash')).not.toThrow();
    expect(() => svc.setAutoAllow('tab-auto', false)).not.toThrow();

    // Unknown tabs are a silent no-op (existing behaviour).
    expect(() => svc.setAutoAllow('unknown', true)).not.toThrow();
    expect(() => svc.addAutoAllowTool('unknown', 'Read')).not.toThrow();

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
      fakeLogging as any,
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

    // Error in hook callback → error level
    options.stderr('Error in hook callback hook_9: Stream closed');
    expect(writeBatch.mock.calls[1][0][0].level).toBe('error');

    // Generic error line → error level
    options.stderr('error: something broke');
    expect(writeBatch.mock.calls[2][0][0].level).toBe('error');

    svc.stopAll();
  });

  // -------------------------------------------------------------------------
  // Wave 3.3 — PreToolUse / PostToolUse / PostToolUseFailure hook callbacks
  // -------------------------------------------------------------------------

  describe('Wave 3.3 audit hooks', () => {
    it('start() sets PreToolUse, PostToolUse, and PostToolUseFailure hook matchers when logging is provided', () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging as any,
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
      expect(options.hooks).toBeDefined();
      expect(Array.isArray(options.hooks.PreToolUse)).toBe(true);
      expect(Array.isArray(options.hooks.PostToolUse)).toBe(true);
      expect(Array.isArray(options.hooks.PostToolUseFailure)).toBe(true);
      expect(typeof options.hooks.PreToolUse[0].hooks[0]).toBe('function');
      expect(typeof options.hooks.PostToolUse[0].hooks[0]).toBe('function');
      expect(typeof options.hooks.PostToolUseFailure[0].hooks[0]).toBe('function');

      svc.stopAll();
    });

    it('PreToolUse callback logs an info entry with tool name + input + returns {}', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging as any,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hooks-pre',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const preHook = fake.getCapturedOptions().hooks.PreToolUse[0].hooks[0];
      const result = await preHook(
        {
          session_id: 'sess-abc',
          transcript_path: '/t',
          cwd: '/p',
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'ls -la' },
          tool_use_id: 'tu-1',
        },
        'tu-1',
        { signal: new AbortController().signal },
      );

      expect(result).toEqual({});
      expect(writeBatch).toHaveBeenCalledTimes(1);
      const entry = writeBatch.mock.calls[0][0][0];
      expect(entry).toMatchObject({
        level: 'info',
        source: 'claude-hooks',
        category: 'session:hooks-pre',
      });
      expect(entry.message).toContain('Bash');
      expect(entry.message).toContain('→');
      expect(typeof entry.metadata).toBe('string');
      const meta = JSON.parse(entry.metadata);
      expect(meta.event).toBe('PreToolUse');
      expect(meta.tool_name).toBe('Bash');
      expect(meta.tool_input).toEqual({ command: 'ls -la' });
      expect(meta.tool_use_id).toBe('tu-1');

      svc.stopAll();
    });

    it('PostToolUse callback logs an info entry with tool name + input + response + returns {}', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging as any,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hooks-post',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const postHook = fake.getCapturedOptions().hooks.PostToolUse[0].hooks[0];
      const result = await postHook(
        {
          session_id: 'sess-abc',
          transcript_path: '/t',
          cwd: '/p',
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/etc/passwd' },
          tool_response: { content: 'root:x:0:0...' },
          tool_use_id: 'tu-2',
        },
        'tu-2',
        { signal: new AbortController().signal },
      );

      expect(result).toEqual({});
      expect(writeBatch).toHaveBeenCalledTimes(1);
      const entry = writeBatch.mock.calls[0][0][0];
      expect(entry).toMatchObject({
        level: 'info',
        source: 'claude-hooks',
        category: 'session:hooks-post',
      });
      expect(entry.message).toContain('Read');
      expect(entry.message).toContain('←');
      const meta = JSON.parse(entry.metadata);
      expect(meta.event).toBe('PostToolUse');
      expect(meta.tool_name).toBe('Read');
      expect(meta.tool_response).toEqual({ content: 'root:x:0:0...' });

      svc.stopAll();
    });

    it('PostToolUseFailure callback logs an error entry with the error + returns {}', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging as any,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hooks-err',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const failHook = fake.getCapturedOptions().hooks.PostToolUseFailure[0].hooks[0];
      const result = await failHook(
        {
          session_id: 'sess-abc',
          transcript_path: '/t',
          cwd: '/p',
          hook_event_name: 'PostToolUseFailure',
          tool_name: 'Bash',
          tool_input: { command: 'nonexistent-cmd' },
          tool_use_id: 'tu-3',
          error: 'command not found: nonexistent-cmd',
        },
        'tu-3',
        { signal: new AbortController().signal },
      );

      expect(result).toEqual({});
      expect(writeBatch).toHaveBeenCalledTimes(1);
      const entry = writeBatch.mock.calls[0][0][0];
      expect(entry).toMatchObject({
        level: 'error',
        source: 'claude-hooks',
        category: 'session:hooks-err',
      });
      expect(entry.message).toContain('Bash');
      expect(entry.message).toContain('✗');
      expect(entry.message).toContain('command not found');
      const meta = JSON.parse(entry.metadata);
      expect(meta.event).toBe('PostToolUseFailure');
      expect(meta.error).toContain('command not found');

      svc.stopAll();
    });

    it('hook metadata is truncated if the tool response is huge (no unbounded log rows)', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging as any,
      );
      const fake = installFakeQuery();
      svc.start({
        tabId: 'hooks-big',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      const postHook = fake.getCapturedOptions().hooks.PostToolUse[0].hooks[0];
      const hugeContent = 'x'.repeat(50_000);
      await postHook(
        {
          session_id: 'sess',
          transcript_path: '/t',
          cwd: '/p',
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/big' },
          tool_response: { content: hugeContent },
          tool_use_id: 'tu-big',
        },
        'tu-big',
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
    });

    // -----------------------------------------------------------------------
    // Bonus hooks — SubagentStart, SubagentStop, PreCompact, FileChanged
    // -----------------------------------------------------------------------

    it('SubagentStart hook logs + emits renderer event', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging as any,
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

      await hook(
        { hook_event_name: 'SubagentStart', agent_id: 'sa-1', agent_type: 'Explore', session_id: 's', transcript_path: '/t', cwd: '/p' },
        undefined,
        { signal: new AbortController().signal },
      );

      expect(writeBatch).toHaveBeenCalledTimes(1);
      const entry = writeBatch.mock.calls[0][0][0];
      expect(entry.source).toBe('claude-hooks');
      expect(entry.message).toContain('Explore');
      expect(entry.message).toContain('started');

      // Renderer event
      const rendererCall = sendToRenderer.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].startsWith('claude-subagent:'),
      );
      expect(rendererCall).toBeDefined();
      expect((rendererCall![1] as any).status).toBe('started');
      expect((rendererCall![1] as any).agent_type).toBe('Explore');

      svc.stopAll();
    });

    it('SubagentStop hook logs + emits renderer event with last_assistant_message', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging as any,
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

      const entry = writeBatch.mock.calls[0][0][0];
      expect(entry.message).toContain('stopped');
      expect(entry.message).toContain('code-reviewer');
      const meta = JSON.parse(entry.metadata);
      expect(meta.last_assistant_message).toContain('3 issues');

      svc.stopAll();
    });

    it('PreCompact hook logs a warning + emits renderer event', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging as any,
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
      expect((rendererCall![1] as any).trigger).toBe('auto');

      svc.stopAll();
    });

    it('Notification hook logs + emits claude-notification for the tab badge system', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging as any,
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

      // Logging
      expect(writeBatch).toHaveBeenCalledTimes(1);
      const entry = writeBatch.mock.calls[0][0][0];
      expect(entry.source).toBe('claude-hooks');
      expect(entry.message).toContain('MCP server disconnected');
      const meta = JSON.parse(entry.metadata);
      expect(meta.notification_type).toBe('warning');
      expect(meta.title).toBe('Connection Lost');

      // Renderer event — uses the existing claude-notification channel so
      // useNotifications.ts picks it up for tab badges automatically
      const rendererCall = sendToRenderer.mock.calls.find(
        (c) => c[0] === 'claude-notification' && (c[1] as any)?.body === 'MCP server disconnected',
      );
      expect(rendererCall).toBeDefined();
      expect((rendererCall![1] as any).tab_id).toBe('hook-notif');
      expect((rendererCall![1] as any).title).toBe('Connection Lost');

      svc.stopAll();
    });

    it('Notification hook marks is_error=true for error-type notifications', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging as any,
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

      const entry = writeBatch.mock.calls[0][0][0];
      expect(entry.level).toBe('error');

      const rendererCall = sendToRenderer.mock.calls.find(
        (c) => c[0] === 'claude-notification' && (c[1] as any)?.body?.includes('Fatal'),
      );
      expect((rendererCall![1] as any).is_error).toBe(true);

      svc.stopAll();
    });

    it('Notification hook emits inline chat message on claude-output channel', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging as any,
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
        (c) => c[0] === 'claude-output:hook-notif-inline' && (c[1] as any)?.subtype === 'notification',
      );
      expect(outputCall).toBeDefined();
      const msg = outputCall![1] as any;
      expect(msg.type).toBe('system');
      expect(msg.subtype).toBe('notification');
      expect(msg.message).toBe('MCP server disconnected');
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
        fakeLogging as any,
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
        (c) => c[0] === 'claude-output:hook-notif-inline-err' && (c[1] as any)?.subtype === 'notification',
      );
      expect(outputCall).toBeDefined();
      expect((outputCall![1] as any).notification_type).toBe('error');

      svc.stopAll();
    });

    it('Notification hook inline message defaults to "info" for unknown types', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging as any,
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
        (c) => c[0] === 'claude-output:hook-notif-inline-info' && (c[1] as any)?.subtype === 'notification',
      );
      expect(outputCall).toBeDefined();
      expect((outputCall![1] as any).notification_type).toBe('info');

      svc.stopAll();
    });

    it('FileChanged hook logs the event + path', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging as any,
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
        fakeLogging as any,
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
        (c) => c[0] === 'claude-output:hook-sess-start' && (c[1] as any)?.subtype === 'session_lifecycle',
      );
      expect(outputCall).toBeDefined();
      expect((outputCall![1] as any).event).toBe('start');
      expect((outputCall![1] as any).source).toBe('startup');

      svc.stopAll();
    });

    it('SessionStart hook handles resume source', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(
        sendToRenderer as any,
        { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
        fakeLogging as any,
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
        fakeLogging as any,
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
        (c) => c[0] === 'claude-output:hook-sess-end' && (c[1] as any)?.subtype === 'session_lifecycle',
      );
      expect(outputCall).toBeDefined();
      expect((outputCall![1] as any).event).toBe('end');
      expect((outputCall![1] as any).reason).toBe('prompt_input_exit');

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
        fakeLogging as any,
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
        fakeLogging as any,
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
        (c) => c[0] === 'claude-output:hook-stop-fail' && (c[1] as any)?.subtype === 'stop_failure',
      );
      expect(outputCall).toBeDefined();
      const msg = outputCall![1] as any;
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
        fakeLogging as any,
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
        fakeLogging as any,
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
        (c) => c[0] === 'claude-output:hook-postcompact' && (c[1] as any)?.subtype === 'post_compact',
      );
      expect(outputCall).toBeDefined();
      const msg = outputCall![1] as any;
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
        fakeLogging as any,
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
        (c) => c[0] === 'claude-output:hook-perm-denied' && (c[1] as any)?.subtype === 'permission_denied',
      );
      expect(outputCall).toBeDefined();
      const msg = outputCall![1] as any;
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
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, fakeLogging as any);
      const fake = installFakeQuery();
      svc.start({ tabId: 'h-ups', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

      const hook = fake.getCapturedOptions().hooks.UserPromptSubmit[0].hooks[0];
      const result = await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hello world', session_title: 'My Session', session_id: 's', transcript_path: '/t', cwd: '/p' }, undefined, { signal: new AbortController().signal });

      expect(result).toEqual({});
      expect(writeBatch).toHaveBeenCalled();
      const entry = writeBatch.mock.calls[0][0][0];
      expect(entry.message).toContain('prompt submitted');
      expect(entry.source).toBe('claude-hooks');
      const outputCall = sendToRenderer.mock.calls.find((c) => c[0] === 'claude-output:h-ups' && (c[1] as any)?.subtype === 'user_prompt_submit');
      expect(outputCall).toBeDefined();

      svc.stopAll();
    });

    it('Setup hook logs trigger and emits renderer notification', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, fakeLogging as any);
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
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, fakeLogging as any);
      const fake = installFakeQuery();
      svc.start({ tabId: 'h-tc', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

      const hook = fake.getCapturedOptions().hooks.TaskCreated[0].hooks[0];
      await hook({ hook_event_name: 'TaskCreated', task_id: 't1', task_subject: 'Fix bug', teammate_name: 'Explorer', session_id: 's', transcript_path: '/t', cwd: '/p' }, undefined, { signal: new AbortController().signal });

      expect(writeBatch.mock.calls[0][0][0].message).toContain('task created: Fix bug');
      const outputCall = sendToRenderer.mock.calls.find((c) => c[0] === 'claude-output:h-tc' && (c[1] as any)?.subtype === 'task_event' && (c[1] as any)?.event === 'created');
      expect(outputCall).toBeDefined();
      expect((outputCall![1] as any).task_subject).toBe('Fix bug');

      svc.stopAll();
    });

    it('TaskCompleted hook logs + emits task_event + triggers notification', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, fakeLogging as any);
      const fake = installFakeQuery();
      svc.start({ tabId: 'h-tcomp', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

      const hook = fake.getCapturedOptions().hooks.TaskCompleted[0].hooks[0];
      await hook({ hook_event_name: 'TaskCompleted', task_id: 't1', task_subject: 'Fix bug', teammate_name: 'Explorer', session_id: 's', transcript_path: '/t', cwd: '/p' }, undefined, { signal: new AbortController().signal });

      expect(writeBatch.mock.calls[0][0][0].message).toContain('task completed: Fix bug');
      const outputCall = sendToRenderer.mock.calls.find((c) => c[0] === 'claude-output:h-tcomp' && (c[1] as any)?.subtype === 'task_event' && (c[1] as any)?.event === 'completed');
      expect(outputCall).toBeDefined();
      expect(showNotification).toHaveBeenCalled();

      svc.stopAll();
    });

    it('Elicitation hook logs but does not auto-accept (onElicitation handles user prompt)', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, fakeLogging as any);
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
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, null as any);
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
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, null as any);
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
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, fakeLogging as any);
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
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, fakeLogging as any);
      const fake = installFakeQuery();
      svc.start({ tabId: 'h-cc', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

      const hook = fake.getCapturedOptions().hooks.ConfigChange[0].hooks[0];
      await hook({ hook_event_name: 'ConfigChange', source: 'project_settings', file_path: '/p/.claude/settings.json', session_id: 's', transcript_path: '/t', cwd: '/p' }, undefined, { signal: new AbortController().signal });

      expect(writeBatch.mock.calls[0][0][0].message).toContain('config changed: project_settings');
      const outputCall = sendToRenderer.mock.calls.find((c) => c[0] === 'claude-output:h-cc' && (c[1] as any)?.subtype === 'config_change');
      expect(outputCall).toBeDefined();
      expect((outputCall![1] as any).source).toBe('project_settings');

      svc.stopAll();
    });

    it('InstructionsLoaded hook logs + emits renderer event', async () => {
      const writeBatch = vi.fn();
      const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
      const svc = createSessionsService(sendToRenderer as any, { showNotification: showNotification as any, incrementUnread: incrementUnread as any }, fakeLogging as any);
      const fake = installFakeQuery();
      svc.start({ tabId: 'h-il', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

      const hook = fake.getCapturedOptions().hooks.InstructionsLoaded[0].hooks[0];
      await hook({ hook_event_name: 'InstructionsLoaded', file_path: '/p/CLAUDE.md', memory_type: 'Project', load_reason: 'session_start', session_id: 's', transcript_path: '/t', cwd: '/p' }, undefined, { signal: new AbortController().signal });

      expect(writeBatch.mock.calls[0][0][0].message).toContain('instructions loaded: /p/CLAUDE.md');
      const outputCall = sendToRenderer.mock.calls.find((c) => c[0] === 'claude-output:h-il' && (c[1] as any)?.subtype === 'instructions_loaded');
      expect(outputCall).toBeDefined();
      expect((outputCall![1] as any).memory_type).toBe('Project');
      expect((outputCall![1] as any).load_reason).toBe('session_start');

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

    it('setThinking("enabled", budget) calls setMaxThinkingTokens(budget)', async () => {
      const fake = installFakeQuery();
      service.start({
        tabId: 'tab-think-budget',
        projectPath: '/p',
        configDir: '/c',
        model: 'sonnet',
        permissionMode: 'default',
      });

      await service.setThinking('tab-think-budget', { type: 'enabled', budgetTokens: 10000 });
      expect(fake.query.setMaxThinkingTokens).toHaveBeenCalledWith(10000);

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

  it('canUseTool always prompts (SDK handles pre-approval internally)', async () => {
    const writeBatch = vi.fn();
    const fakeLogging = { writeBatch, query: vi.fn(), count: vi.fn(), prune: vi.fn() };
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
      fakeLogging as any,
    );
    const fake = installFakeQuery();

    svc.start({
      tabId: 'tab-auto-partial',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    const canUseTool = fake.getCapturedOptions().canUseTool;
    // canUseTool always emits a permission_request — the SDK only calls it
    // when it needs a decision (pre-approved tools never reach this callback)
    const pending = canUseTool('Bash', { command: 'ls' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-auto',
    });

    await new Promise((r) => setImmediate(r));
    expect(svc.getStatus('tab-auto-partial')).toBe('waiting_permission');

    svc.respondPermission('tab-auto-partial', 'deny');
    await pending;

    svc.stopAll();
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
