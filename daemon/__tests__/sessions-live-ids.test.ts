// @vitest-environment node
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

    void sessions.start({
      tabId: 'tab-a',
      projectPath: '/Users/test/proj',
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
    });
    const idA = sessions.getSessionId('tab-a');
    expect(idA).toBeTruthy();
    expect(sessions.listActiveSessionIds()).toEqual([idA]);

    void sessions.start({
      tabId: 'tab-b',
      projectPath: '/Users/test/other',
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
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
    const seen: string[][] = [];
    let closedId: string | null = null;
    const sessions = createSessionsService(
      vi.fn(), null, null, null,
      (sessionId) => {
        closedId = sessionId;
        seen.push(sessions.listActiveSessionIds());
      },
    );

    void sessions.start({
      tabId: 'tab-close',
      projectPath: '/Users/test/proj',
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
    });
    const id = sessions.getSessionId('tab-close');
    sessions.stop('tab-close');

    expect(closedId).toBe(id);
    expect(seen).toEqual([[]]);
  });

  it('tells the close hook whether a tab closed or the process is shutting down', () => {
    const reasons: string[] = [];
    const sessions = createSessionsService(
      vi.fn(), null, null, null,
      (_id, _p, _c, reason) => { reasons.push(reason); },
    );
    for (const tabId of ['t1', 't2', 't3']) {
      void sessions.start({ tabId, projectPath: '/Users/test/proj', configDir: tmpConfig, model: '', permissionMode: '' });
    }
    sessions.stop('t1');
    sessions.stopAll();
    expect(reasons).toEqual(['closed', 'shutdown', 'shutdown']);
  });
});
