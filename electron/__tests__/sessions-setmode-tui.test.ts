// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Stub the rich engine so start({ mode: 'rich' }) doesn't actually spawn
// the CLI subprocess. Only `close()` matters for these tests — setMode('tui')
// awaits it before swapping in the pty.
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

import { spawn as ptySpawn } from 'node-pty';
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
  tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-setmode-tui-'));
});

afterEach(() => {
  fs.rmSync(tmpConfig, { recursive: true, force: true });
});

describe("setMode('tui') after a rich-mode start — resume vs fresh-start", () => {
  it("spawns claude with --session-id (not --resume) when no JSONL exists for the session", async () => {
    const projectPath = '/Users/test/proj';
    const sendToRenderer = vi.fn();
    const sessions = createSessionsService(sendToRenderer);

    sessions.start({
      tabId: 'tab-fresh',
      projectPath,
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      mode: 'rich',
    });

    const sessionId = sessions.getSessionId('tab-fresh');
    expect(sessionId).toBeTruthy();

    // Sanity: no JSONL on disk yet. The CLI engine hasn't written one
    // because nothing has been said.
    const jsonlPath = path.join(
      tmpConfig,
      'projects',
      encodeProjectKey(projectPath),
      `${sessionId!}.jsonl`,
    );
    expect(fs.existsSync(jsonlPath)).toBe(false);

    await sessions.setMode('tab-fresh', 'tui');

    const spawnArgs = vi.mocked(ptySpawn).mock.calls[0]?.[1];
    expect(spawnArgs).toBeDefined();
    expect(spawnArgs).toEqual(['--session-id', sessionId]);
  });

  it("spawns claude with --resume when a JSONL transcript already exists", async () => {
    const projectPath = '/Users/test/proj';
    const sendToRenderer = vi.fn();
    const sessions = createSessionsService(sendToRenderer);

    sessions.start({
      tabId: 'tab-resume',
      projectPath,
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      mode: 'rich',
    });

    const sessionId = sessions.getSessionId('tab-resume');
    expect(sessionId).toBeTruthy();

    // Drop a JSONL file at the path the CLI would have written to.
    const projectDir = path.join(tmpConfig, 'projects', encodeProjectKey(projectPath));
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, `${sessionId!}.jsonl`);
    fs.writeFileSync(jsonlPath, '{"type":"user","message":{"role":"user","content":"hi"}}\n');

    await sessions.setMode('tab-resume', 'tui');

    const spawnArgs = vi.mocked(ptySpawn).mock.calls[0]?.[1];
    expect(spawnArgs).toBeDefined();
    expect(spawnArgs).toEqual(['--resume', sessionId]);
  });
});
