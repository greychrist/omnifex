// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

// With no JSONL yet, `--resume` makes the CLI exit "No conversation found with
// session ID".
describe('start() with resumeSessionId — resume vs fresh transcript', () => {
  const projectPath = '/Users/test/proj';

  function jsonlPathFor(sessionId: string): string {
    return path.join(tmpConfig, 'projects', encodeProjectId(projectPath), `${sessionId}.jsonl`);
  }

  it('does not resume a session id that has no transcript on disk', () => {
    const sessions = createSessionsService(vi.fn());
    const orphanId = '2355e496-3a5d-4013-989b-0477635adc4f';
    expect(fs.existsSync(jsonlPathFor(orphanId))).toBe(false);

    void sessions.start({
      tabId: 'tab-orphan',
      projectPath,
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      resumeSessionId: orphanId,
    });

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0]?.[0]).toMatchObject({ resume: false });
  });

  it('keeps the same session id when it declines to resume', () => {
    const sessions = createSessionsService(vi.fn());
    const orphanId = '2355e496-3a5d-4013-989b-0477635adc4f';

    void sessions.start({
      tabId: 'tab-orphan-id',
      projectPath,
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
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

    void sessions.start({
      tabId: 'tab-real',
      projectPath,
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      resumeSessionId: realId,
    });

    expect(startSpy.mock.calls[0]?.[0]).toMatchObject({ resume: true, sessionId: realId });
  });

  it('resumes a transcript the CLI moved into a worktree project directory', () => {
    // The CLI's `--resume <id>` finds a transcript moved into a worktree from the
    // original cwd (2.1.290).
    const sessions = createSessionsService(vi.fn());
    const movedId = '7277e428-749a-4af5-bc73-18e7d2b2b15f';
    const dir = path.join(
      tmpConfig,
      'projects',
      encodeProjectId(`${projectPath}/.claude/worktrees/PI-620`),
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${movedId}.jsonl`),
      '{"type":"user","message":{"role":"user","content":"hi"}}\n',
    );

    void sessions.start({
      tabId: 'tab-moved',
      projectPath,
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      resumeSessionId: movedId,
    });

    expect(startSpy.mock.calls[0]?.[0]).toMatchObject({ resume: true, sessionId: movedId });
  });

  it('cold start without a resume id still does not resume', () => {
    const sessions = createSessionsService(vi.fn());

    void sessions.start({
      tabId: 'tab-cold',
      projectPath,
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
    });

    expect(startSpy.mock.calls[0]?.[0]).toMatchObject({ resume: false });
  });
});
