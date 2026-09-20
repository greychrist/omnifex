// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentMessage, AgentEngineExit } from '../services/agents/types';

// The session owns its turn axis: a prompt opens it, the CLI's result row
// (or the process going away) closes it. Nothing here is inferred from the
// transcript — see docs/session-lifecycle.md.

const messageCbs: Array<(m: AgentMessage) => void> = [];
const exitCbs: Array<(info: AgentEngineExit) => void> = [];

vi.mock('../services/agents/claude-cli-engine', () => ({
  createClaudeCliEngine: vi.fn(() => ({
    kind: 'claude',
    applyExtendedPermissionMode: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    sendStructured: vi.fn(async () => {}),
    sendControlRequest: vi.fn(async () => undefined),
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
import { encodeProjectId } from '../services/project-paths';

let tmpConfig: string;
const projectPath = '/Users/test/proj';

beforeEach(() => {
  messageCbs.length = 0;
  exitCbs.length = 0;
  tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-turn-'));
});
afterEach(() => { fs.rmSync(tmpConfig, { recursive: true, force: true }); });

function setup() {
  const sent: { channel: string; payload: unknown }[] = [];
  const sessions = createSessionsService((channel: string, ...args: unknown[]) => {
    sent.push({ channel, payload: args[0] });
  });
  const turnEvents = () => sent.filter((s) => s.channel === 'session-turn:t1').map((s) => s.payload);
  return { sessions, sent, turnEvents };
}

function emitResult(): void {
  for (const cb of messageCbs) {
    cb({ payload: { type: 'result', subtype: 'success', is_error: false, result: 'done' }, receivedAt: '2026-09-20T00:00:02.000Z' } as AgentMessage);
  }
}

describe('sessions — the turn axis', () => {
  it('is idle for a tab the service does not know', () => {
    const { sessions } = setup();
    expect(sessions.getTurn('nope')).toEqual({ status: 'idle', since: null });
  });

  it('starts idle, opens on send with a timestamp, and announces both', () => {
    const { sessions, turnEvents } = setup();
    sessions.start({ tabId: 't1', projectPath, configDir: tmpConfig, model: 'opus', permissionMode: 'default' });
    expect(sessions.getTurn('t1')).toEqual({ status: 'idle', since: null });

    sessions.sendMessage('t1', 'hello');
    const turn = sessions.getTurn('t1');
    expect(turn.status).toBe('running');
    expect(typeof turn.since).toBe('string');
    expect(Number.isFinite(Date.parse(turn.since as string))).toBe(true);
    expect(turnEvents()).toEqual([turn]);
    expect(sessions.getHealth('t1')).toMatchObject({ alive: true, turn });
  });

  it('closes on the CLI result row — the only turn-closer while the process lives', () => {
    const { sessions, turnEvents } = setup();
    sessions.start({ tabId: 't1', projectPath, configDir: tmpConfig, model: 'opus', permissionMode: 'default' });
    sessions.sendMessage('t1', 'hello');
    // Assistant output does not close it.
    for (const cb of messageCbs) cb({ payload: { type: 'assistant', message: { role: 'assistant', content: [] } }, receivedAt: '2026-09-20T00:00:01.000Z' } as AgentMessage);
    expect(sessions.getTurn('t1').status).toBe('running');
    emitResult();
    expect(sessions.getTurn('t1')).toEqual({ status: 'idle', since: null });
    expect(turnEvents().map((t) => (t as { status: string }).status)).toEqual(['running', 'idle']);
  });

  it('closes when the process exits mid-turn', () => {
    const { sessions } = setup();
    sessions.start({ tabId: 't1', projectPath, configDir: tmpConfig, model: 'opus', permissionMode: 'default' });
    sessions.sendMessage('t1', 'hello');
    for (const cb of exitCbs) cb({ code: 1 });
    expect(sessions.getTurn('t1').status).toBe('idle');
  });

  it('closes when the session is stopped mid-turn', () => {
    const { sessions, turnEvents } = setup();
    sessions.start({ tabId: 't1', projectPath, configDir: tmpConfig, model: 'opus', permissionMode: 'default' });
    sessions.sendMessage('t1', 'hello');
    sessions.stop('t1');
    expect(sessions.getTurn('t1').status).toBe('idle');
    expect(turnEvents().at(-1)).toEqual({ status: 'idle', since: null });
  });

  it('a resumed session is idle until the user sends — the transcript never decides', () => {
    // The transcript on disk ends mid-turn (assistant tool_use, its
    // tool_result, and nothing after: the old process died). The new
    // `--resume` process starts fresh and is not working on anything.
    const { sessions, turnEvents } = setup();
    const id = '2355e496-3a5d-4013-989b-0477635adc4f';
    const dir = path.join(tmpConfig, 'projects', encodeProjectId(projectPath));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'do it' }, timestamp: '2026-09-18T05:10:00.000Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] }, timestamp: '2026-09-18T05:10:01.000Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }, timestamp: '2026-09-18T05:10:02.000Z' }),
    ].join('\n') + '\n');

    sessions.start({ tabId: 't1', projectPath, configDir: tmpConfig, model: 'opus', permissionMode: 'default', resumeSessionId: id });
    expect(sessions.getTurn('t1')).toEqual({ status: 'idle', since: null });
    expect(turnEvents()).toEqual([]);
  });
});
