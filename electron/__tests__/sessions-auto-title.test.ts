// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// One shared spy across every engine the service builds, so the assertions
// can ask "was a title ever requested?" without knowing which handle asked.
const sendControlRequestSpy = vi.fn(async (_subtype: string, _payload: unknown) => undefined);

vi.mock('../services/agents/claude-cli-engine', () => ({
  createClaudeCliEngine: vi.fn(() => ({
    kind: 'claude',
    applyExtendedPermissionMode: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    sendStructured: vi.fn(async () => {}),
    sendControlRequest: sendControlRequestSpy,
    respondPermission: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    kill: vi.fn(),
    getResumeId: vi.fn(() => null),
    getInitData: vi.fn(() => null),
    onMessage: vi.fn(() => ({ dispose() {} })),
    onPermissionRequest: vi.fn(() => ({ dispose() {} })),
    onError: vi.fn(() => ({ dispose() {} })),
    onExit: vi.fn(() => ({ dispose() {} })),
  })),
}));

vi.mock('../services/sessions/binary', () => ({
  findSystemClaudeBinary: vi.fn(() => '/usr/local/bin/claude'),
}));

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { createSessionsService } from '../services/sessions';
import { encodeProjectId } from '../services/project-paths';
import { shouldAutoTitle, autoTitleDescription } from '../services/sessions/auto-title';

const projectPath = '/Users/test/proj';
let tmpConfig: string;

beforeEach(() => {
  sendControlRequestSpy.mockClear();
  tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-auto-title-'));
});

afterEach(() => {
  fs.rmSync(tmpConfig, { recursive: true, force: true });
});

function titleCalls(): unknown[][] {
  return sendControlRequestSpy.mock.calls.filter((c) => c[0] === 'generate_session_title');
}

describe('shouldAutoTitle', () => {
  it('names a fresh session on its first prompt', () => {
    expect(shouldAutoTitle({ attempted: false, prompt: 'Reduce the chat bar height' })).toBe(true);
  });

  it('fires at most once per session', () => {
    expect(shouldAutoTitle({ attempted: true, prompt: 'Reduce the chat bar height' })).toBe(false);
  });

  it('skips a blank prompt', () => {
    expect(shouldAutoTitle({ attempted: false, prompt: '   ' })).toBe(false);
  });

  it('skips a slash command', () => {
    // "/resume" or "/compact" would name the session after the command
    // rather than the work. The CLI's own auto-title gate excluded these too.
    expect(shouldAutoTitle({ attempted: false, prompt: '/resume' })).toBe(false);
    expect(shouldAutoTitle({ attempted: false, prompt: '  /compact keep the plan' })).toBe(false);
  });

  it('does not mistake a file path for a slash command', () => {
    expect(shouldAutoTitle({ attempted: false, prompt: '/Users/test/proj/src/App.tsx is broken' }))
      .toBe(true);
  });
});

describe('autoTitleDescription', () => {
  it('joins the text blocks of a structured message', () => {
    expect(autoTitleDescription([
      { type: 'image', source: {} },
      { type: 'text', text: 'Why is this button misaligned?' },
    ])).toBe('Why is this button misaligned?');
  });

  it('is empty when a structured message carries no text', () => {
    expect(autoTitleDescription([{ type: 'image', source: {} }])).toBe('');
  });
});

describe('sendMessage — session auto-naming', () => {
  it('asks the CLI to name a fresh session on the first prompt, and persists it', () => {
    const sessions = createSessionsService(vi.fn());
    sessions.start({
      tabId: 'tab-fresh',
      projectPath,
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
    });

    sessions.sendMessage('tab-fresh', 'Reduce the chat bar height');

    expect(titleCalls()).toHaveLength(1);
    expect(titleCalls()[0]?.[1]).toEqual({
      description: 'Reduce the chat bar height',
      persist: true,
    });
  });

  it('does not ask again on later prompts in the same session', () => {
    const sessions = createSessionsService(vi.fn());
    sessions.start({
      tabId: 'tab-twice',
      projectPath,
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
    });

    sessions.sendMessage('tab-twice', 'Reduce the chat bar height');
    sessions.sendMessage('tab-twice', 'Now put the label above the toggle');

    expect(titleCalls()).toHaveLength(1);
  });

  it('leaves a resumed session alone', () => {
    // A resumed conversation either already carries a title or is one of the
    // nameless ones from the 2.1.277+ gap; either way a name derived from a
    // prompt landing mid-conversation is worse than none. Those rename by hand.
    const sessions = createSessionsService(vi.fn());
    const realId = '11111111-2222-3333-4444-555555555555';
    const dir = path.join(tmpConfig, 'projects', encodeProjectId(projectPath));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${realId}.jsonl`),
      '{"type":"user","message":{"role":"user","content":"hi"}}\n',
    );

    sessions.start({
      tabId: 'tab-resumed',
      projectPath,
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      resumeSessionId: realId,
    });

    sessions.sendMessage('tab-resumed', 'Reduce the chat bar height');

    expect(titleCalls()).toHaveLength(0);
  });

  it('names a session whose first message is an image with a caption', () => {
    const sessions = createSessionsService(vi.fn());
    sessions.start({
      tabId: 'tab-structured',
      projectPath,
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
    });

    sessions.sendStructuredMessage('tab-structured', [
      { type: 'image', source: {} },
      { type: 'text', text: 'Why is this button misaligned?' },
    ]);

    expect(titleCalls()).toHaveLength(1);
    expect(titleCalls()[0]?.[1]).toMatchObject({ description: 'Why is this button misaligned?' });
  });

  it('never lets a failed naming call surface as a session error', async () => {
    sendControlRequestSpy.mockRejectedValueOnce(new Error('control channel closed'));
    const sessions = createSessionsService(vi.fn());
    sessions.start({
      tabId: 'tab-reject',
      projectPath,
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
    });

    expect(() => { sessions.sendMessage('tab-reject', 'Reduce the chat bar height'); }).not.toThrow();
    await Promise.resolve();
    expect(sessions.getStatus('tab-reject').sessionStatus).not.toBe('error');
  });
});
