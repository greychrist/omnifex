// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Capture what start() was asked to do. The engine is stubbed so nothing
// spawns; `resume` is the whole subject of these tests.
const startSpy = vi.fn(async (_opts: Record<string, unknown>) => {});

vi.mock('../services/agents/claude-cli-engine', () => ({
  createClaudeCliEngine: vi.fn(() => ({
    kind: 'claude',
    applyExtendedPermissionMode: vi.fn(async () => {}),
    start: startSpy,
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

import { createSessionsService } from '../services/sessions';
import { encodeProjectId } from '../services/project-paths';

let tmpConfig: string;

beforeEach(() => {
  startSpy.mockClear();
  tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-start-resume-'));
});

afterEach(() => {
  fs.rmSync(tmpConfig, { recursive: true, force: true });
});

// A session's UUID is pinned at spawn and pushed to the renderer immediately,
// so `claudeSessionId` exists long before the CLI writes a transcript. Reconnect
// and restart both hand that id back as `resumeSessionId`. If the user never
// sent a message, there is no JSONL, and `--resume` makes the CLI exit with
// "No conversation found with session ID: …" — the session dies on the spot.
//
// restartQuery() and setMode('tui') already guard this by checking the JSONL;
// start() is the third resume path and was missing the same check.
describe('start() with resumeSessionId — resume vs fresh transcript', () => {
  const projectPath = '/Users/test/proj';

  function jsonlPathFor(sessionId: string): string {
    return path.join(tmpConfig, 'projects', encodeProjectId(projectPath), `${sessionId}.jsonl`);
  }

  it('does not resume a session id that has no transcript on disk', () => {
    const sessions = createSessionsService(vi.fn());
    const orphanId = '2355e496-3a5d-4013-989b-0477635adc4f';
    expect(fs.existsSync(jsonlPathFor(orphanId))).toBe(false);

    sessions.start({
      tabId: 'tab-orphan',
      projectPath,
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      mode: 'rich',
      resumeSessionId: orphanId,
    });

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0]?.[0]).toMatchObject({ resume: false });
  });

  it('keeps the same session id when it declines to resume', () => {
    // Falling back to a fresh UUID would strand the renderer, which already
    // has the old id, and orphan whatever the user does next under a
    // different transcript.
    const sessions = createSessionsService(vi.fn());
    const orphanId = '2355e496-3a5d-4013-989b-0477635adc4f';

    sessions.start({
      tabId: 'tab-orphan-id',
      projectPath,
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      mode: 'rich',
      resumeSessionId: orphanId,
    });

    expect(sessions.getSessionId('tab-orphan-id')).toBe(orphanId);
    expect(startSpy.mock.calls[0]?.[0]).toMatchObject({ sessionId: orphanId });
  });

  it('resumes when the transcript exists', () => {
    const sessions = createSessionsService(vi.fn());
    const realId = '11111111-2222-3333-4444-555555555555';
    const dir = path.join(tmpConfig, 'projects', encodeProjectId(projectPath));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      jsonlPathFor(realId),
      '{"type":"user","message":{"role":"user","content":"hi"}}\n',
    );

    sessions.start({
      tabId: 'tab-real',
      projectPath,
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      mode: 'rich',
      resumeSessionId: realId,
    });

    expect(startSpy.mock.calls[0]?.[0]).toMatchObject({ resume: true, sessionId: realId });
  });

  it('cold start without a resume id still does not resume', () => {
    const sessions = createSessionsService(vi.fn());

    sessions.start({
      tabId: 'tab-cold',
      projectPath,
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      mode: 'rich',
    });

    expect(startSpy.mock.calls[0]?.[0]).toMatchObject({ resume: false });
  });
});
