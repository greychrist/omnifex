// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentMessage, AgentEngineExit } from '../services/agents/types';
import type { CliUsageEvent } from '../services/cost/cli-process-usage';

// The sessions service reads the CLI's running totals at the three moments
// they matter: a baseline when a process starts, every result, and after a
// side question (which no result may follow). None of it may disturb the
// session — a failing recorder must not fail the side question.

const messageCbs: ((m: AgentMessage) => void)[] = [];
const exitCbs: ((info: AgentEngineExit) => void)[] = [];
const control = vi.fn();

vi.mock('../services/agents/claude-cli-engine', () => ({
  createClaudeCliEngine: vi.fn(() => ({
    kind: 'claude',
    applyExtendedPermissionMode: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    sendStructured: vi.fn(async () => {}),
    sendControlRequest: vi.fn((subtype: string, params: unknown) => Promise.resolve(control(subtype, params))),
    respondPermission: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    kill: vi.fn(),
    getResumeId: vi.fn(() => null),
    getInitData: vi.fn(() => null),
    onMessage: vi.fn((cb: (m: AgentMessage) => void) => { messageCbs.push(cb); return { dispose() {} }; }),
    onPermissionRequest: vi.fn(() => ({ dispose() {} })),
    onError: vi.fn(() => ({ dispose() {} })),
    onExit: vi.fn((cb: (info: AgentEngineExit) => void) => { exitCbs.push(cb); return { dispose() {} }; }),
  })),
}));

vi.mock('../services/sessions/binary', () => ({
  findSystemClaudeBinary: vi.fn(() => '/usr/local/bin/claude'),
}));

import { createSessionsService } from '../services/sessions';

const OPUS = { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 };
let tmpConfig: string;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  messageCbs.length = 0;
  exitCbs.length = 0;
  control.mockReset();
  control.mockImplementation((subtype: string) => {
    if (subtype === 'get_usage') return { session: { model_usage: { 'claude-opus-5-5[1m]': OPUS } } };
    if (subtype === 'side_question') return { response: 'answer', synthetic: false };
    return undefined;
  });
  tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-cliusage-'));
});
afterEach(() => { fs.rmSync(tmpConfig, { recursive: true, force: true }); });

function setup(sink: (e: CliUsageEvent) => void) {
  const sent: { channel: string; payload: unknown }[] = [];
  const sessions = createSessionsService(
    (channel: string, ...args: unknown[]) => { sent.push({ channel, payload: args[0] }); },
    {}, null, null, null, null, null, null, null, null, null, null, null,
    sink,
  );
  sessions.start({ tabId: 't1', projectPath: '/Users/test/proj', configDir: tmpConfig, model: 'opus', permissionMode: 'default' });
  return { sessions, sent };
}

describe('sessions — CLI usage capture', () => {
  it('records a baseline when the process starts', async () => {
    const events: CliUsageEvent[] = [];
    setup((e) => { events.push(e); });
    await flush();
    expect(control).toHaveBeenCalledWith('get_usage', { skip_behaviors: true });
    expect(events).toEqual([expect.objectContaining({ phase: 'baseline', modelUsage: { 'claude-opus-5-5[1m]': OPUS } })]);
  });

  it('records the running totals on every result', async () => {
    const events: CliUsageEvent[] = [];
    setup((e) => { events.push(e); });
    await flush();
    for (const cb of messageCbs) {
      cb({ payload: { type: 'result', subtype: 'success', is_error: false, result: 'done', modelUsage: { 'claude-opus-5-5[1m]': OPUS } }, receivedAt: 't' } as AgentMessage);
    }
    expect(events.at(-1)).toMatchObject({ phase: 'latest' });
  });

  it('refreshes the totals after a side question settles', async () => {
    const events: CliUsageEvent[] = [];
    const { sessions } = setup((e) => { events.push(e); });
    await flush();
    const before = events.length;
    await sessions.askSideQuestion('t1', 'q');
    await flush(); await flush();
    expect(events.slice(before)).toEqual([expect.objectContaining({ phase: 'latest' })]);
  });

  it('a recorder that throws never fails the side question', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sessions } = setup(() => { throw new Error('db locked'); });
    await flush();
    await sessions.askSideQuestion('t1', 'q');
    await flush(); await flush();
    expect(sessions.getSideChat('t1').exchanges[0]).toMatchObject({ status: 'answered', answer: 'answer' });
    warn.mockRestore();
  });
});
