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

vi.mock('../services/sessions/factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/sessions/factory')>();
  return { ...actual, findSystemClaudeBinary: () => '/usr/local/bin/claude' };
});

// Also mock the binary module (used transitively via factory re-export).
vi.mock('../services/sessions/binary', () => ({
  findSystemClaudeBinary: vi.fn(() => '/usr/local/bin/claude'),
}));

// ---------------------------------------------------------------------------
// start({ mode: 'tui' }) — integration test
// ---------------------------------------------------------------------------

import { spawn as ptySpawn } from 'node-pty';
import { createSessionsService } from '../services/sessions';

describe('start({ mode: "tui" })', () => {
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
});
