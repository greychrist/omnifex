// @vitest-environment node
//
// Covers the rich → tui → rich round-trip on setMode. The first toggle
// (rich → tui) disposes the engine's onMessage/onError/onExit subscriptions
// via runtime.ts's exit handler. Toggling back must re-attach them — without
// re-attachment, the new child's stdout emits into the void and
// agent-output:<tabId> never reaches the renderer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  AgentEngine,
  AgentEngineExit,
  AgentMessage,
  AgentPermissionRequest,
  Disposable,
} from '../services/agents/types';

interface InstrumentedEngine extends AgentEngine {
  __emitMessage(payload: unknown): void;
  __emitPermission(req: AgentPermissionRequest): void;
  __messageSubscriberCount(): number;
}

function createInstrumentedEngine(tabId: string): InstrumentedEngine {
  const messageCbs: Array<(m: AgentMessage) => void> = [];
  const errorCbs: Array<(err: Error) => void> = [];
  const exitCbs: Array<(info: AgentEngineExit) => void> = [];
  const permissionCbs: Array<(r: AgentPermissionRequest) => void> = [];

  const subscribe = <T>(arr: T[], cb: T): Disposable => {
    arr.push(cb);
    return {
      dispose() {
        const i = arr.indexOf(cb);
        if (i !== -1) arr.splice(i, 1);
      },
    };
  };

  return {
    kind: 'claude',
    start: vi.fn(async () => {}),
    applyExtendedPermissionMode: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    sendStructured: vi.fn(async () => {}),
    sendControlRequest: (async () => undefined) as AgentEngine['sendControlRequest'],
    respondPermission: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    // Faithfully simulate the real engine: close() kills the child, which
    // fires exit on the next tick. Firing inside close() keeps the test
    // deterministic — by the time `await engine.close()` resolves, the
    // runtime's onExit handler has already run and disposed subscriptions.
    close: vi.fn(async () => {
      for (const cb of [...exitCbs]) cb({ code: 0 });
    }),
    kill: vi.fn(),
    getResumeId: vi.fn(() => null),
    getInitData: vi.fn(() => null),
    onMessage: vi.fn((cb) => subscribe(messageCbs, cb)),
    onPermissionRequest: vi.fn((cb) => subscribe(permissionCbs, cb)),
    onError: vi.fn((cb) => subscribe(errorCbs, cb)),
    onExit: vi.fn((cb) => subscribe(exitCbs, cb)),
    __emitMessage(payload: unknown) {
      const msg: AgentMessage = {
        agent: 'claude',
        tabId,
        receivedAt: new Date().toISOString(),
        sessionId: null,
        payload,
      };
      for (const cb of [...messageCbs]) cb(msg);
    },
    __emitPermission(req: AgentPermissionRequest) {
      for (const cb of [...permissionCbs]) cb(req);
    },
    __messageSubscriberCount() {
      return messageCbs.length;
    },
  };
}

vi.mock('../services/agents/claude-cli-engine', () => ({
  createClaudeCliEngine: vi.fn(),
}));

vi.mock('../services/sessions/binary', () => ({
  findSystemClaudeBinary: vi.fn(() => '/usr/local/bin/claude'),
}));

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { spawn as ptySpawn } from 'node-pty';
import { createClaudeCliEngine } from '../services/agents/claude-cli-engine';
import { createSessionsService } from '../services/sessions';
import { encodeProjectKey } from '../services/sessions/summary-query';

function makeFakePty() {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
  };
}

let tmpConfig: string;

beforeEach(() => {
  vi.mocked(ptySpawn).mockReset();
  vi.mocked(ptySpawn).mockReturnValue(makeFakePty() as never);
  tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-setmode-rt-'));
});

afterEach(() => {
  fs.rmSync(tmpConfig, { recursive: true, force: true });
});

describe('setMode: rich → tui → rich round-trip', () => {
  it('re-attaches engine listeners so claude-output keeps flowing after toggling back to rich', async () => {
    const tabId = 'tab-roundtrip';
    const engine = createInstrumentedEngine(tabId);
    vi.mocked(createClaudeCliEngine).mockReturnValue(engine);

    const sendToRenderer = vi.fn();
    const sessions = createSessionsService(sendToRenderer);

    sessions.start({
      tabId,
      projectPath: '/Users/test/proj',
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      mode: 'rich',
    });

    // After initial start(), listenToMessages has attached one onMessage
    // subscription.
    expect(engine.__messageSubscriberCount()).toBe(1);

    // rich → tui: closes the engine; runtime's onExit handler disposes
    // the subscription.
    await sessions.setMode(tabId, 'tui');
    expect(engine.__messageSubscriberCount()).toBe(0);

    // tui → rich: should re-attach a fresh subscription so the resumed
    // engine's output is routed to the renderer again.
    sendToRenderer.mockClear();
    await sessions.setMode(tabId, 'rich');
    expect(engine.__messageSubscriberCount()).toBeGreaterThan(0);

    // Simulate the engine emitting a result message after the toggle.
    engine.__emitMessage({ type: 'result', subtype: 'success' });

    expect(sendToRenderer).toHaveBeenCalledWith(
      `agent-output:${tabId}`,
      expect.objectContaining({ type: 'result' }),
    );
  });

  it('re-attaches the engine listener after rich → tui → rich so result events reach the renderer', async () => {
    // Regression: without listener re-attachment after tui→rich, the engine's
    // stdout emits into the void — agent-output events never reach the renderer.
    const tabId = 'tab-roundtrip-status';
    const engine = createInstrumentedEngine(tabId);
    vi.mocked(createClaudeCliEngine).mockReturnValue(engine);

    const sendToRenderer = vi.fn();
    const sessions = createSessionsService(sendToRenderer);

    sessions.start({
      tabId,
      projectPath: '/Users/test/proj',
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      mode: 'rich',
    });

    await sessions.setMode(tabId, 'tui');
    await sessions.setMode(tabId, 'rich');

    // listInFlightTabIds always returns [] after Task 3 (conversationStatus
    // tracking moved to the renderer). Verify the engine listeners ARE
    // re-attached by checking that result messages reach the renderer.
    expect(sessions.listInFlightTabIds()).toEqual([]);

    sessions.sendMessage(tabId, 'hello');
    engine.__emitMessage({ type: 'result', subtype: 'success' });

    expect(sendToRenderer).toHaveBeenCalledWith(
      `agent-output:${tabId}`,
      expect.objectContaining({ type: 'result' }),
    );
  });

  it('passes resume:false on tui → rich when the CLI never wrote a JSONL for this sessionId', async () => {
    // Repro: user starts a session in rich, switches to TUI before sending
    // any message, then switches back to rich. Neither side wrote a JSONL,
    // so passing `--resume <id>` makes the CLI exit with
    // "No conversation found with session ID …" and boots the user out.
    // `setMode('tui')` already guards against this around its createTuiSession
    // call; the symmetric guard on the return path was missing.
    const tabId = 'tab-rt-no-jsonl';
    const engine = createInstrumentedEngine(tabId);
    vi.mocked(createClaudeCliEngine).mockReturnValue(engine);

    const sendToRenderer = vi.fn();
    const sessions = createSessionsService(sendToRenderer);

    sessions.start({
      tabId,
      projectPath: '/Users/test/proj',
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      mode: 'rich',
    });

    await sessions.setMode(tabId, 'tui');

    vi.mocked(engine.start).mockClear();
    await sessions.setMode(tabId, 'rich');

    expect(engine.start).toHaveBeenCalledWith(expect.objectContaining({ resume: false }));
  });

  it('passes resume:true on tui → rich when a JSONL already exists for this sessionId', async () => {
    const tabId = 'tab-rt-with-jsonl';
    const engine = createInstrumentedEngine(tabId);
    vi.mocked(createClaudeCliEngine).mockReturnValue(engine);

    const sendToRenderer = vi.fn();
    const sessions = createSessionsService(sendToRenderer);

    sessions.start({
      tabId,
      projectPath: '/Users/test/proj',
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      mode: 'rich',
    });

    const sessionId = sessions.getSessionId(tabId)!;
    const jsonlPath = path.join(
      tmpConfig,
      'projects',
      encodeProjectKey('/Users/test/proj'),
      `${sessionId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
    fs.writeFileSync(jsonlPath, '');

    await sessions.setMode(tabId, 'tui');

    vi.mocked(engine.start).mockClear();
    await sessions.setMode(tabId, 'rich');

    expect(engine.start).toHaveBeenCalledWith(expect.objectContaining({ resume: true }));
  });
});

describe('setMode: permission queue drain guard', () => {
  it('drains a pending permission with deny so the resolver does not dangle', async () => {
    // Regression guard: if the renderer's modeToggleDisabled gate is bypassed
    // (e.g. via a programmatic IPC call) while a permission is queued, setMode
    // must drain the queue instead of leaving resolvers dangling.
    const tabId = 'tab-perm-drain';
    const engine = createInstrumentedEngine(tabId);
    vi.mocked(createClaudeCliEngine).mockReturnValue(engine);

    const sendToRenderer = vi.fn();
    const sessions = createSessionsService(sendToRenderer);

    sessions.start({
      tabId,
      projectPath: '/Users/test/proj',
      configDir: tmpConfig,
      model: '',
      permissionMode: '', // → 'default' → queues the permission
      mode: 'rich',
    });

    // Fire a permission request through the engine. Under 'default' mode this
    // pushes an entry onto the permissionQueue and emits agent-output to the
    // renderer. The PendingPermission.resolve is a no-op in the real engine
    // flow — what we care about is that the queue is emptied and setMode
    // completes without throwing.
    engine.__emitPermission({
      agent: 'claude',
      requestId: 'req-drain-1',
      kind: 'tool',
      summary: 'Bash',
      payload: { tool_name: 'Bash', input: { command: 'ls' } },
    });

    // Queue has one entry — confirm via the IPC emission.
    expect(sendToRenderer).toHaveBeenCalledWith(
      `agent-output:${tabId}`,
      expect.objectContaining({ type: 'permission_request', request_id: 'req-drain-1' }),
    );

    // setMode should drain the queue and succeed without throwing.
    await expect(sessions.setMode(tabId, 'tui')).resolves.toBeUndefined();

    // After the drain, respondPermission is a no-op (queue is empty).
    // Verify by calling it and checking engine.respondPermission was NOT called.
    sessions.respondPermission(tabId, 'allow');
    expect(engine.respondPermission).not.toHaveBeenCalled();
  });
});
