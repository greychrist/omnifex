// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverNewSessionFile } from '../services/sessions/tui-coldstart';

// ---------------------------------------------------------------------------
// Mocks needed by the integration test further down.
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
// discoverNewSessionFile — unit tests (unchanged)
// ---------------------------------------------------------------------------

describe('discoverNewSessionFile', () => {
  let configDir: string;
  let projectsDir: string;
  const projectPath = '/Users/test/myproj';
  const encoded = '-Users-test-myproj';

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-coldstart-'));
    projectsDir = path.join(configDir, 'projects', encoded);
    fs.mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('resolves with the new JSONL file when one appears after the snapshot', async () => {
    fs.writeFileSync(path.join(projectsDir, 'old-session.jsonl'), '');
    const discoveryP = discoverNewSessionFile({ configDir, projectPath, timeoutMs: 2000 });
    // Simulate the CLI creating a new file after spawn
    setTimeout(() => {
      fs.writeFileSync(path.join(projectsDir, 'new-session-uuid.jsonl'), '');
    }, 100);
    const result = await discoveryP;
    expect(result.sessionId).toBe('new-session-uuid');
    expect(result.jsonlPath).toBe(path.join(projectsDir, 'new-session-uuid.jsonl'));
  });

  it('creates the projects directory if missing', async () => {
    fs.rmSync(projectsDir, { recursive: true });
    const discoveryP = discoverNewSessionFile({ configDir, projectPath, timeoutMs: 2000 });
    setTimeout(() => {
      fs.mkdirSync(projectsDir, { recursive: true });
      fs.writeFileSync(path.join(projectsDir, 'first.jsonl'), '');
    }, 100);
    const result = await discoveryP;
    expect(result.sessionId).toBe('first');
  });

  it('rejects when no new file appears within the timeout', async () => {
    fs.writeFileSync(path.join(projectsDir, 'only.jsonl'), '');
    await expect(
      discoverNewSessionFile({ configDir, projectPath, timeoutMs: 300 })
    ).rejects.toThrow(/timed out/i);
  });
});

// ---------------------------------------------------------------------------
// start({ mode: 'tui' }) — integration test
// ---------------------------------------------------------------------------

import { spawn as ptySpawn } from 'node-pty';
import { createSessionsService } from '../services/sessions';

describe('start({ mode: "tui" })', () => {
  it('spawns claude with no --resume and resolves sessionId from the new JSONL file', async () => {
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

    // Simulate the CLI creating the JSONL after spawn
    setTimeout(() => {
      fs.writeFileSync(
        path.join(tmpConfig, 'projects', encoded, 'sid-new.jsonl'),
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-new' }) + '\n',
      );
    }, 50);

    // Wait until sessionId is captured
    const waitUntil = async (predicate: () => boolean, timeoutMs = 3000): Promise<boolean> => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 30));
      }
      return predicate();
    };

    await waitUntil(() => sessions.getSessionId('cold-1') === 'sid-new');
    expect(sessions.getSessionId('cold-1')).toBe('sid-new');
    expect(vi.mocked(ptySpawn).mock.calls[0][1]).toEqual([]); // no --resume

    fs.rmSync(tmpConfig, { recursive: true, force: true });
  });
});
