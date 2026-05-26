// @vitest-environment node
//
// Covers the rich → tui → rich round-trip on setMode. The first toggle
// (rich → tui) disposes the engine's onMessage/onError/onExit subscriptions
// via runtime.ts's exit handler. Toggling back must re-attach them — without
// re-attachment, the new child's stdout emits into the void and
// claude-output:<tabId> never reaches the renderer.
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
      `claude-output:${tabId}`,
      expect.objectContaining({ type: 'result' }),
    );
  });

  it('clears conversationStatus back to idle when a result arrives after rich → tui → rich', async () => {
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

    // User sends a message — optimistically flips conversationStatus to
    // 'running'. Without re-attached listeners, the result event never
    // fires the idle flip, leaving the session stuck "in flight" forever.
    sessions.sendMessage(tabId, 'hello');
    expect(sessions.listInFlightTabIds()).toContain(tabId);

    engine.__emitMessage({ type: 'result', subtype: 'success' });

    expect(sessions.listInFlightTabIds()).not.toContain(tabId);
  });
});
