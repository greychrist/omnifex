// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentPermissionRequest } from '../services/agents/types';

// A chat message sent while an AskUserQuestion card is on screen is the
// user's reply to it: the question is answered as `replied_in_chat` before
// the message is written, so the CLI is not left blocked on the card with
// the message queued behind it.

const permissionCbs: Array<(r: AgentPermissionRequest) => void> = [];
const stdin: string[] = [];
const caps = { current: ['ask_user_question_unanswered_v1'] as string[] | null };

vi.mock('../services/agents/claude-cli-engine', () => ({
  createClaudeCliEngine: vi.fn(() => ({
    kind: 'claude',
    applyExtendedPermissionMode: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    send: vi.fn(async (p: string) => { stdin.push(`prompt:${p}`); }),
    sendStructured: vi.fn(async () => { stdin.push('structured'); }),
    sendControlRequest: vi.fn(async () => undefined),
    respondPermission: vi.fn(async (id: string, behavior: string, body: any) => {
      stdin.push(`answer:${id}:${behavior}:${JSON.stringify(body?.updatedInput?.annotations ?? null)}`);
    }),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    kill: vi.fn(),
    getResumeId: vi.fn(() => null),
    getInitData: vi.fn(() => (caps.current ? { capabilities: caps.current } : null)),
    onMessage: vi.fn(() => ({ dispose() {} })),
    onPermissionRequest: vi.fn((cb: (r: AgentPermissionRequest) => void) => { permissionCbs.push(cb); return { dispose() {} }; }),
    onError: vi.fn(() => ({ dispose() {} })),
    onExit: vi.fn(() => ({ dispose() {} })),
  })),
}));

vi.mock('../services/sessions/binary', () => ({
  findSystemClaudeBinary: vi.fn(() => '/usr/local/bin/claude'),
}));

import { createSessionsService } from '../services/sessions';

let tmpConfig: string;
beforeEach(() => {
  permissionCbs.length = 0;
  stdin.length = 0;
  caps.current = ['ask_user_question_unanswered_v1'];
  tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-qchat-'));
});
afterEach(() => { fs.rmSync(tmpConfig, { recursive: true, force: true }); });

function startWithQuestion() {
  const sessions = createSessionsService(() => {});
  sessions.start({ tabId: 't1', projectPath: '/Users/test/proj', configDir: tmpConfig, model: 'opus', permissionMode: 'default' });
  for (const cb of permissionCbs) {
    cb({
      agent: 'claude', requestId: 'q1', kind: 'tool', summary: 'AskUserQuestion',
      payload: { tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which DB?', options: [] }] }, tool_use_id: 'tu1' },
    });
  }
  return sessions;
}

describe('sessions — chat reply to an open question', () => {
  it('answers the question as replied_in_chat, then writes the message', () => {
    const sessions = startWithQuestion();
    sessions.sendMessage('t1', 'use postgres');
    expect(stdin).toEqual([
      'answer:q1:allow:{"Which DB?":{"unanswered":"replied_in_chat"}}',
      'prompt:use postgres',
    ]);
  });

  it('does the same for a structured message', () => {
    const sessions = startWithQuestion();
    sessions.sendStructuredMessage('t1', [{ type: 'text', text: 'see image' }]);
    expect(stdin[0]).toMatch(/^answer:q1:allow:/);
    expect(stdin[1]).toBe('structured');
  });

  it('leaves the question open on a CLI without the capability', () => {
    caps.current = null;
    const sessions = startWithQuestion();
    sessions.sendMessage('t1', 'use postgres');
    expect(stdin).toEqual(['prompt:use postgres']);
  });
});
