// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentMessage } from '../services/agents/types';

// A mod's delayed notification sent with `until_back` is thrown away if the
// person returns to the session first (CLI 2.1.321 contract). The daemon's
// evidence of a return is the user sending the session a message.

const messageCbs: Array<(m: AgentMessage) => void> = [];

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
    onExit: vi.fn(() => ({ dispose() {} })),
  })),
}));

vi.mock('../services/sessions/binary', () => ({
  findSystemClaudeBinary: vi.fn(() => '/usr/local/bin/claude'),
}));

import { createSessionsService } from '../services/sessions';

let tmpConfig: string;
beforeEach(() => {
  messageCbs.length = 0;
  tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-modback-'));
});
afterEach(() => { fs.rmSync(tmpConfig, { recursive: true, force: true }); });

function startWithWaitingNotice(untilBack: boolean) {
  const sendToRenderer = vi.fn();
  const sessions = createSessionsService(sendToRenderer);
  sessions.start({ tabId: 't1', projectPath: '/Users/test/proj', configDir: tmpConfig, model: 'opus', permissionMode: 'default' });
  const payload = {
    type: 'system', subtype: 'ui_notify', plugin: 'r', source: 'r@inline', title: 'T', text: 'B',
    key: 'k', delay_ms: 60_000, until_back: untilBack, rewritten: false, uuid: 'u', session_id: 's',
  };
  for (const cb of messageCbs) cb({ agent: 'claude', tabId: 't1', receivedAt: '', sessionId: 's', payload });
  return { sessions, sendToRenderer };
}

const removals = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.filter((c) => c[0] === 'claude-notification-remove');

describe('sessions — a user send withdraws until_back mod notifications', () => {
  it('on a prompt', () => {
    const { sessions, sendToRenderer } = startWithWaitingNotice(true);
    sessions.sendMessage('t1', 'hi');
    expect(removals(sendToRenderer)).toEqual([['claude-notification-remove', { ids: ['mod:s:r@inline:k'] }]]);
  });

  it('on a structured message', () => {
    const { sessions, sendToRenderer } = startWithWaitingNotice(true);
    sessions.sendStructuredMessage('t1', [{ type: 'text', text: 'x' }]);
    expect(removals(sendToRenderer)).toHaveLength(1);
  });

  it('leaves a notice sent without until_back', () => {
    const { sessions, sendToRenderer } = startWithWaitingNotice(false);
    sessions.sendMessage('t1', 'hi');
    expect(removals(sendToRenderer)).toEqual([]);
  });
});
