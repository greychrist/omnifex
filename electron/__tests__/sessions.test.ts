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
  /** The options passed to the SDK — captured so tests can poke canUseTool. */
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
    interrupt: vi.fn(),
    setPermissionMode: vi.fn(),
    setModel: vi.fn(),
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
    expect(typeof options.canUseTool).toBe('function');
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

  it('sends claude-error + cleans up when the stream throws', async () => {
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

    expect(sendToRenderer).toHaveBeenCalledWith(
      'claude-error:tab-throw',
      'stream blew up',
    );
    expect(sendToRenderer).toHaveBeenCalledWith('claude-complete:tab-throw');
    expect(service.isActive('tab-throw')).toBe(false);
    // Keep the channel referenced so TS doesn't complain about the unused var
    channel.close();
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
  // Permission flow — exercising canUseTool directly
  // -------------------------------------------------------------------------

  it('canUseTool emits a permission_request and resolves to allow when respondPermission("allow") is called', async () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-perm',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    const options = fake.getCapturedOptions();
    const decisionPromise = options.canUseTool(
      'Bash',
      { command: 'ls -la' },
      { signal: new AbortController().signal, title: 'Run Bash', description: 'List files' },
    );

    // The request should have been emitted and the session should be waiting
    expect(service.getStatus('tab-perm')).toBe('waiting_permission');
    const permCall = sendToRenderer.mock.calls.find(
      (c) => c[0] === 'claude-output:tab-perm' && (c[1] as any)?.type === 'permission_request',
    );
    expect(permCall).toBeDefined();
    expect((permCall![1] as any).tool_name).toBe('Bash');
    expect((permCall![1] as any).tool_input).toEqual({ command: 'ls -la' });

    // Respond with allow + (optional) updated input
    service.respondPermission('tab-perm', 'allow', { command: 'ls -la --color' });

    const decision = await decisionPromise;
    expect(decision.behavior).toBe('allow');
    expect((decision as any).updatedInput).toEqual({ command: 'ls -la --color' });
    expect(service.getStatus('tab-perm')).toBe('running');
  });

  it('canUseTool falls back to the original input when respondPermission is called without updatedInput', async () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-perm-fallback',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    const options = fake.getCapturedOptions();
    const originalInput = { command: 'echo hi' };
    const decisionPromise = options.canUseTool('Bash', originalInput, {
      signal: new AbortController().signal,
    });

    service.respondPermission('tab-perm-fallback', 'allow');

    const decision = await decisionPromise;
    expect(decision.behavior).toBe('allow');
    expect((decision as any).updatedInput).toBe(originalInput);
  });

  it('canUseTool resolves to deny when respondPermission("deny") is called', async () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-deny',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    const options = fake.getCapturedOptions();
    const decisionPromise = options.canUseTool(
      'Write',
      { path: '/etc/passwd' },
      { signal: new AbortController().signal },
    );

    service.respondPermission('tab-deny', 'deny');

    const decision = await decisionPromise;
    expect(decision.behavior).toBe('deny');
  });

  it('auto-allow short-circuits the permission flow for allow-listed tools', async () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-auto',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    service.setAutoAllow('tab-auto', true);
    service.addAutoAllowTool('tab-auto', 'Read');

    const options = fake.getCapturedOptions();
    const decision = await options.canUseTool(
      'Read',
      { path: '/tmp/a.txt' },
      { signal: new AbortController().signal },
    );

    expect(decision.behavior).toBe('allow');
    expect(decision.updatedInput).toEqual({ path: '/tmp/a.txt' });
    // No permission_request should have been sent for auto-allowed tools
    const permCall = sendToRenderer.mock.calls.find(
      (c) => c[0] === 'claude-output:tab-auto' && (c[1] as any)?.type === 'permission_request',
    );
    expect(permCall).toBeUndefined();
  });

  it('auto-allow only skips tools in the per-session allow-list', async () => {
    const fake = installFakeQuery();

    service.start({
      tabId: 'tab-auto-partial',
      projectPath: '/p',
      configDir: '/c',
      model: 'sonnet',
      permissionMode: 'default',
    });

    service.setAutoAllow('tab-auto-partial', true);
    service.addAutoAllowTool('tab-auto-partial', 'Read');

    const options = fake.getCapturedOptions();
    // Bash is NOT in the allow-list → should emit a permission_request
    const pending = options.canUseTool(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal },
    );

    expect(service.getStatus('tab-auto-partial')).toBe('waiting_permission');

    // Clean up the pending promise so the session can shut down cleanly
    service.respondPermission('tab-auto-partial', 'deny');
    await pending;
  });
});
