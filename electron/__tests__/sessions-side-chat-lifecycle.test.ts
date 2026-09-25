// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentMessage, AgentEngineExit } from '../services/agents/types';

// The side chat lives exactly as long as the session's engine. When the
// engine goes — it exits, the tab is stopped, or a fresh start replaces it —
// clients must be told the thread is gone, and a question still in flight
// must not bring it back when its rejection lands afterwards.

const exitCbs: ((info: AgentEngineExit) => void)[] = [];
const pendingRejects: ((e: Error) => void)[] = [];

vi.mock('../services/agents/claude-cli-engine', () => ({
  createClaudeCliEngine: vi.fn(() => ({
    kind: 'claude',
    applyExtendedPermissionMode: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    sendStructured: vi.fn(async () => {}),
    sendControlRequest: vi.fn((subtype: string) =>
      subtype === 'side_question'
        ? new Promise((_res, rej) => { pendingRejects.push(rej); })
        : Promise.resolve(undefined)),
    respondPermission: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    kill: vi.fn(),
    getResumeId: vi.fn(() => null),
    getInitData: vi.fn(() => null),
    onMessage: vi.fn((_cb: (m: AgentMessage) => void) => ({ dispose() {} })),
    onPermissionRequest: vi.fn(() => ({ dispose() {} })),
    onError: vi.fn(() => ({ dispose() {} })),
    onExit: vi.fn((cb: (info: AgentEngineExit) => void) => { exitCbs.push(cb); return { dispose() {} }; }),
  })),
}));

vi.mock('../services/sessions/binary', () => ({
  findSystemClaudeBinary: vi.fn(() => '/usr/local/bin/claude'),
}));

import { createSessionsService } from '../services/sessions';

let tmpConfig: string;
const projectPath = '/Users/test/proj';
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  exitCbs.length = 0;
  pendingRejects.length = 0;
  tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-sidechat-'));
});
afterEach(() => { fs.rmSync(tmpConfig, { recursive: true, force: true }); });

function setup() {
  const sent: { channel: string; payload: unknown }[] = [];
  const sessions = createSessionsService((channel: string, ...args: unknown[]) => {
    sent.push({ channel, payload: args[0] });
  });
  const lastSideChat = () => sent.filter((s) => s.channel === 'session-side-chat:t1').at(-1)?.payload;
  const start = () => sessions.start({ tabId: 't1', projectPath, configDir: tmpConfig, model: 'opus', permissionMode: 'default' });
  return { sessions, lastSideChat, start };
}

describe('side chat — ends with the engine', () => {
  it('an engine exit with a question pending leaves the thread empty', async () => {
    const { sessions, lastSideChat, start } = setup();
    start();
    await sessions.askSideQuestion('t1', 'q');
    // The engine's exit path: failAll queues the rejection, then exit callbacks run.
    const reject = pendingRejects[0];
    for (const cb of exitCbs) cb({ code: 0 });
    reject(new Error('control_request aborted: engine exited'));
    await flush();
    expect(lastSideChat()).toEqual({ exchanges: [] });
  });

  it('stop() empties the thread, and a late rejection does not refill it', async () => {
    const { sessions, lastSideChat, start } = setup();
    start();
    await sessions.askSideQuestion('t1', 'q');
    sessions.stop('t1');
    expect(lastSideChat()).toEqual({ exchanges: [] });
    pendingRejects[0](new Error('control_request aborted: engine exited'));
    await flush();
    expect(lastSideChat()).toEqual({ exchanges: [] });
  });

  it('a fresh start over a live tab empties the old thread', async () => {
    const { sessions, lastSideChat, start } = setup();
    start();
    await sessions.askSideQuestion('t1', 'q');
    start();
    expect(lastSideChat()).toEqual({ exchanges: [] });
    pendingRejects[0](new Error('control_request aborted: engine exited'));
    await flush();
    expect(lastSideChat()).toEqual({ exchanges: [] });
  });

  it('closing a side chat whose session is gone still tells clients it is empty', () => {
    const { sessions, lastSideChat } = setup();
    sessions.closeSideChat('t1');
    expect(lastSideChat()).toEqual({ exchanges: [] });
  });
});
