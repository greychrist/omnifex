import { describe, it, expect, vi } from 'vitest';
import { listenToMessages } from '../services/sessions/runtime';
import type {
  SessionHandle,
  SendToRenderer,
} from '../services/sessions/types';
import type {
  AgentEngine,
  AgentEngineExit,
  AgentMessage,
  AgentPermissionRequest,
} from '../services/agents/types';
import type { LoggingService, LogEntry } from '../services/logging';

interface FakeEngine extends AgentEngine {
  _emitError: (err: Error) => void;
  _emitExit: (info?: AgentEngineExit) => void;
  _emitMessage: (payload: unknown) => void;
}

function makeFakeEngine(): FakeEngine {
  const messageCbs: Array<(m: AgentMessage) => void> = [];
  const errorCbs: Array<(err: Error) => void> = [];
  const exitCbs: Array<(info: AgentEngineExit) => void> = [];

  const engine: AgentEngine = {
    kind: 'claude',
    start: vi.fn(async () => {}),
    applyExtendedPermissionMode: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    sendStructured: vi.fn(async () => {}),
    sendControlRequest: vi.fn(async () => undefined) as AgentEngine['sendControlRequest'],
    respondPermission: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    kill: vi.fn(),
    getResumeId: vi.fn(() => null),
    getInitData: vi.fn(() => null),
    onMessage: vi.fn((cb: (m: AgentMessage) => void) => {
      messageCbs.push(cb);
      return { dispose() { const i = messageCbs.indexOf(cb); if (i !== -1) messageCbs.splice(i, 1); } };
    }),
    onPermissionRequest: vi.fn((_cb: (r: AgentPermissionRequest) => void) => ({ dispose() {} })),
    onError: vi.fn((cb: (err: Error) => void) => {
      errorCbs.push(cb);
      return { dispose() { const i = errorCbs.indexOf(cb); if (i !== -1) errorCbs.splice(i, 1); } };
    }),
    onExit: vi.fn((cb: (info: AgentEngineExit) => void) => {
      exitCbs.push(cb);
      return { dispose() { const i = exitCbs.indexOf(cb); if (i !== -1) exitCbs.splice(i, 1); } };
    }),
  };
  const fake = engine as FakeEngine;
  fake._emitError = (err) => { for (const cb of errorCbs) cb(err); };
  fake._emitExit = (info = { code: 0 }) => { for (const cb of exitCbs) cb(info); };
  fake._emitMessage = (payload) => {
    const msg: AgentMessage = {
      agent: 'claude',
      tabId: 'tab-1',
      receivedAt: new Date().toISOString(),
      sessionId: 'sess-1',
      payload,
    };
    for (const cb of messageCbs) cb(msg);
  };
  return fake;
}

function makeHandle(engine: AgentEngine): SessionHandle {
  return {
    engine,
    initData: null,
    permissionMode: 'default',
    startParams: {
      projectPath: '/p',
      configDir: '/c',
      model: 'claude-opus-4-7',
      permissionMode: 'default',
    },
    sessionId: 'sess-1',
    sessionStatus: 'started',
    conversationStatus: 'idle',
    mode: 'rich',
    tui: null,
    tuiDetach: null,
    tuiJsonl: null,
    permissionResolver: null,
    permissionQueue: [],
    elicitationResolver: null,
    projectPath: '/p',
    configDir: '/c',
  };
}

function makeLoggingStub(): { service: LoggingService; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const service: LoggingService = {
    writeBatch(batch) { entries.push(...batch); },
    query: vi.fn(() => ({ entries: [], total: 0 })),
    count: vi.fn(() => 0),
    prune: vi.fn(() => 0),
  };
  return { service, entries };
}

describe('runtime.listenToMessages — engine.onError', () => {
  it('does NOT emit claude-complete on stderr-driven error', () => {
    const engine = makeFakeEngine();
    const handle = makeHandle(engine);
    const sendToRenderer: SendToRenderer = vi.fn();
    const sessions = new Map<string, SessionHandle>([['tab-1', handle]]);

    void listenToMessages('tab-1', handle, {
      sendToRenderer,
      notificationHooks: {},
      rateLimitHook: null,
      ownership: null,
      sessions,
    });

    engine._emitError(new Error('benign stderr noise: 1 MCP server needs auth'));

    const sendMock = vi.mocked(sendToRenderer);
    const channels = sendMock.mock.calls.map((c) => c[0] as string);
    expect(channels).not.toContain('claude-complete:tab-1');
  });

  it('does NOT transition sessionStatus to error', () => {
    const engine = makeFakeEngine();
    const handle = makeHandle(engine);
    const sendToRenderer: SendToRenderer = vi.fn();
    const sessions = new Map<string, SessionHandle>([['tab-1', handle]]);

    void listenToMessages('tab-1', handle, {
      sendToRenderer,
      notificationHooks: {},
      rateLimitHook: null,
      ownership: null,
      sessions,
    });

    engine._emitError(new Error('any error'));

    expect(handle.sessionStatus).toBe('started');
    expect(handle.conversationStatus).toBe('idle');

    const sendMock = vi.mocked(sendToRenderer);
    const statusCalls = sendMock.mock.calls.filter(
      (c) => c[0] === 'session-status:tab-1',
    );
    // No status flip was emitted.
    for (const call of statusCalls) {
      const payload = call[1] as { sessionStatus?: string };
      expect(payload.sessionStatus).not.toBe('error');
    }
  });

  it('logs the error to the logging service at level=error', () => {
    const engine = makeFakeEngine();
    const handle = makeHandle(engine);
    const sendToRenderer: SendToRenderer = vi.fn();
    const sessions = new Map<string, SessionHandle>([['tab-1', handle]]);
    const { service, entries } = makeLoggingStub();

    void listenToMessages('tab-1', handle, {
      sendToRenderer,
      notificationHooks: {},
      rateLimitHook: null,
      ownership: null,
      sessions,
      logging: service,
    });

    engine._emitError(new Error('MCP auth required'));

    const errorEntries = entries.filter((e) => e.level === 'error');
    expect(errorEntries.length).toBe(1);
    expect(errorEntries[0].source).toBe('backend');
    expect(errorEntries[0].category).toBe('session:tab-1');
    expect(errorEntries[0].message).toContain('MCP auth required');
  });

  it('still emits claude-error to the renderer so the LogService toast/log path runs', () => {
    const engine = makeFakeEngine();
    const handle = makeHandle(engine);
    const sendToRenderer: SendToRenderer = vi.fn();
    const sessions = new Map<string, SessionHandle>([['tab-1', handle]]);

    void listenToMessages('tab-1', handle, {
      sendToRenderer,
      notificationHooks: {},
      rateLimitHook: null,
      ownership: null,
      sessions,
    });

    engine._emitError(new Error('something happened'));

    expect(sendToRenderer).toHaveBeenCalledWith(
      'claude-error:tab-1',
      expect.stringContaining('something happened'),
    );
  });
});

describe('runtime.listenToMessages — engine.onExit', () => {
  it('emits claude-complete on clean exit (preserved)', () => {
    const engine = makeFakeEngine();
    const handle = makeHandle(engine);
    const sendToRenderer: SendToRenderer = vi.fn();
    const sessions = new Map<string, SessionHandle>([['tab-1', handle]]);

    void listenToMessages('tab-1', handle, {
      sendToRenderer,
      notificationHooks: {},
      rateLimitHook: null,
      ownership: null,
      sessions,
    });

    engine._emitExit({ code: 0 });

    expect(sendToRenderer).toHaveBeenCalledWith('claude-complete:tab-1');
    expect(handle.sessionStatus).toBe('stopped');
  });

  it('does NOT emit claude-complete when the handle has been replaced (StrictMode / restart)', () => {
    const engine = makeFakeEngine();
    const handle = makeHandle(engine);
    const sendToRenderer: SendToRenderer = vi.fn();
    // Simulate a fresh handle replacing the old one for the same tab.
    const newHandle = makeHandle(makeFakeEngine());
    const sessions = new Map<string, SessionHandle>([['tab-1', newHandle]]);

    void listenToMessages('tab-1', handle, {
      sendToRenderer,
      notificationHooks: {},
      rateLimitHook: null,
      ownership: null,
      sessions,
    });

    engine._emitExit({ code: 0 });

    const sendMock = vi.mocked(sendToRenderer);
    const channels = sendMock.mock.calls.map((c) => c[0] as string);
    expect(channels).not.toContain('claude-complete:tab-1');
  });
});
