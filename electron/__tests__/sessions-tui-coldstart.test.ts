// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Mocks needed by the integration test.
// vi.mock() calls are hoisted — they're in effect for the whole file.
// ---------------------------------------------------------------------------

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

vi.mock('../services/sessions/binary', () => ({
  findSystemClaudeBinary: vi.fn(() => '/usr/local/bin/claude'),
}));

// ---------------------------------------------------------------------------
// start({ mode: 'tui' }) — integration test
// ---------------------------------------------------------------------------

import { spawn as ptySpawn } from 'node-pty';
import { createSessionsService } from '../services/sessions';

describe('start({ mode: "tui" })', () => {
  it('propagates cold-start errors (missing configDir) so IPC rejects', async () => {
    vi.mocked(ptySpawn).mockReset();
    const sendToRenderer = vi.fn();
    const sessions = createSessionsService(sendToRenderer);
    // Intentionally omit configDir — startTuiColdStart throws synchronously.
    const result = sessions.start({
      tabId: 'cold-err',
      projectPath: '/Users/test/proj',
      configDir: '',
      model: '',
      permissionMode: '',
      mode: 'tui',
    });
    // start() now returns a promise for TUI mode — it must reject.
    await expect(Promise.resolve(result)).rejects.toThrow(/configDir/i);
  });

  it('spawns claude with --session-id <uuid> and sets handle.sessionId to that uuid immediately', async () => {
    const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-startcold-'));
    const projectPath = '/Users/test/proj';
    const encoded = '-Users-test-proj';
    fs.mkdirSync(path.join(tmpConfig, 'projects', encoded), { recursive: true });

    // Fake pty
    const fakePty = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
    };
    vi.mocked(ptySpawn).mockReset();
    vi.mocked(ptySpawn).mockReturnValue(fakePty as any);

    const sendToRenderer = vi.fn();
    const sessions = createSessionsService(sendToRenderer);

    sessions.start({
      tabId: 'cold-1',
      projectPath,
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      mode: 'tui',
    });

    // sessionId is set deterministically at start — no race, no polling.
    const sessionId = sessions.getSessionId('cold-1');
    expect(sessionId).toBeTruthy();
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // Confirm the CLI was spawned with --session-id <that uuid>.
    const spawnArgs = vi.mocked(ptySpawn).mock.calls[0][1];
    expect(spawnArgs).toEqual(['--session-id', sessionId]);

    // Confirm session-mode event fired.
    const modeCall = sendToRenderer.mock.calls.find((c) => c[0] === 'session-mode:cold-1');
    expect(modeCall).toBeTruthy();
    expect(modeCall?.[1]).toEqual({ mode: 'tui' });

    fs.rmSync(tmpConfig, { recursive: true, force: true });
  });

  it('reuses resumeSessionId and spawns claude with --resume when provided', async () => {
    const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-tuiresume-'));
    const projectPath = '/Users/test/proj';
    fs.mkdirSync(path.join(tmpConfig, 'projects', '-Users-test-proj'), { recursive: true });

    const fakePty = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
    };
    vi.mocked(ptySpawn).mockReset();
    vi.mocked(ptySpawn).mockReturnValue(fakePty as any);

    const sendToRenderer = vi.fn();
    const sessions = createSessionsService(sendToRenderer);

    const existingId = '11111111-2222-3333-4444-555555555555';

    sessions.start({
      tabId: 'tui-resume-1',
      projectPath,
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      mode: 'tui',
      resumeSessionId: existingId,
    });

    // handle.sessionId should be the passed id, not a freshly minted one.
    expect(sessions.getSessionId('tui-resume-1')).toBe(existingId);

    // CLI must be spawned with --resume <existingId>, not --session-id.
    const spawnArgs = vi.mocked(ptySpawn).mock.calls[0][1];
    expect(spawnArgs).toEqual(['--resume', existingId]);

    fs.rmSync(tmpConfig, { recursive: true, force: true });
  });
});
