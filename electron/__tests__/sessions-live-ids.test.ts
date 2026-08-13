// @vitest-environment node
//
// The registry is the only place that knows which session UUIDs are open right
// now. The Brain needs that set: a transcript whose session is still running is
// still being written, so indexing it distils a partial conversation and marks
// it done.
//
// The ordering test below is the load-bearing one. `stop()` deletes the handle
// BEFORE it fires `onSessionClosed`, and auto-index-on-close (main.ts) enqueues
// the closed session from inside that hook. If teardown is ever reordered so
// the hook fires first, the just-closed session looks live to the Brain and
// auto-indexing silently stops happening — with no error anywhere.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../services/agents/claude-cli-engine', () => ({
  createClaudeCliEngine: vi.fn(),
}));
vi.mock('../services/sessions/binary', () => ({
  findSystemClaudeBinary: vi.fn(() => '/usr/local/bin/claude'),
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { spawn as ptySpawn } from 'node-pty';
import { createClaudeCliEngine } from '../services/agents/claude-cli-engine';
import { createSessionsService } from '../services/sessions';

function makeFakePty() {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
  };
}

function makeFakeEngine() {
  return {
    kind: 'claude' as const,
    start: vi.fn(async () => {}),
    applyExtendedPermissionMode: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    sendStructured: vi.fn(async () => {}),
    sendControlRequest: (async () => undefined) as never,
    respondPermission: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onMessage: () => ({ dispose: () => {} }),
    onError: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    onPermissionRequest: () => ({ dispose: () => {} }),
  } as unknown as ReturnType<typeof createClaudeCliEngine>;
}

let tmpConfig: string;

beforeEach(() => {
  vi.mocked(ptySpawn).mockReset();
  vi.mocked(ptySpawn).mockReturnValue(makeFakePty() as never);
  vi.mocked(createClaudeCliEngine).mockReturnValue(makeFakeEngine());
  tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-live-ids-'));
});

afterEach(() => {
  fs.rmSync(tmpConfig, { recursive: true, force: true });
});

describe('listActiveSessionIds', () => {
  it('reports the UUID of every open session, and nothing after it closes', () => {
    const sessions = createSessionsService(vi.fn());

    sessions.start({
      tabId: 'tab-a',
      projectPath: '/Users/test/proj',
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      mode: 'rich',
    });
    const idA = sessions.getSessionId('tab-a');
    expect(idA).toBeTruthy();
    expect(sessions.listActiveSessionIds()).toEqual([idA]);

    sessions.start({
      tabId: 'tab-b',
      projectPath: '/Users/test/other',
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      mode: 'rich',
    });
    const idB = sessions.getSessionId('tab-b');
    expect(new Set(sessions.listActiveSessionIds())).toEqual(new Set([idA, idB]));

    sessions.stop('tab-a');
    expect(sessions.listActiveSessionIds()).toEqual([idB]);
    sessions.stop('tab-b');
    expect(sessions.listActiveSessionIds()).toEqual([]);
  });

  it('starts empty', () => {
    expect(createSessionsService(vi.fn()).listActiveSessionIds()).toEqual([]);
  });

  it('has already dropped the session by the time onSessionClosed fires', () => {
    // Auto-index-on-close enqueues from inside this hook. If the session were
    // still listed as live here, the Brain's live-session guard would refuse
    // the very session that just closed, and nothing would ever index it.
    const seen: string[][] = [];
    let closedId: string | null = null;
    const sessions = createSessionsService(
      vi.fn(), {}, null, null, null, null,
      (sessionId) => {
        closedId = sessionId;
        seen.push(sessions.listActiveSessionIds());
      },
    );

    sessions.start({
      tabId: 'tab-close',
      projectPath: '/Users/test/proj',
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      mode: 'rich',
    });
    const id = sessions.getSessionId('tab-close');
    sessions.stop('tab-close');

    expect(closedId).toBe(id);
    expect(seen).toEqual([[]]);
  });
});
