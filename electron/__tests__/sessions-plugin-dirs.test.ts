// @vitest-environment node
//
// OmniFex's bundled mod reaches the CLI as `--plugin-dir`. The sessions layer
// asks for the dirs at each spawn, and a stream-death restart must keep them:
// the restart path once dropped `effort` the same way.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../services/agents/claude-cli-engine', () => ({ createClaudeCliEngine: vi.fn() }));
vi.mock('../services/sessions/binary', () => ({
  findSystemClaudeBinary: vi.fn(() => '/usr/local/bin/claude'),
  findSystemCodexBinary: vi.fn(() => null),
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { createClaudeCliEngine } from '../services/agents/claude-cli-engine';
import { createSessionsService } from '../services/sessions';
import { restartQuery } from '../services/sessions/runtime';
import type { RuntimeDeps } from '../services/sessions/runtime';
import type { SessionHandle } from '../services/sessions/types';

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
  };
}

/** createSessionsService with only the trailing pluginDirs parameter set. */
function serviceWith(pluginDirs: (() => string[]) | null) {
  const args = new Array(14).fill(undefined);
  return (createSessionsService as unknown as (...a: unknown[]) => ReturnType<typeof createSessionsService>)(
    vi.fn(), ...args, pluginDirs,
  );
}

let tmpConfig: string;
let engine: ReturnType<typeof makeFakeEngine>;

beforeEach(() => {
  engine = makeFakeEngine();
  vi.mocked(createClaudeCliEngine).mockReturnValue(engine as never);
  tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-plugin-dirs-'));
});
afterEach(() => { fs.rmSync(tmpConfig, { recursive: true, force: true }); });

const start = (svc: ReturnType<typeof serviceWith>) => svc.start({
  tabId: 't1', projectPath: '/Users/test/proj', configDir: tmpConfig, model: 'opus', permissionMode: 'default',
});

describe('sessions.start → plugin dirs', () => {
  it('spawns with the dirs the closure returns', () => {
    start(serviceWith(() => ['/state/mod/omnifex']));
    expect(engine.start).toHaveBeenCalledWith(expect.objectContaining({ pluginDirs: ['/state/mod/omnifex'] }));
  });

  it('spawns with none when the closure throws — the mod never blocks a session', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    start(serviceWith(() => { throw new Error('boom'); }));
    expect(engine.start).toHaveBeenCalledWith(expect.objectContaining({ pluginDirs: [] }));
    warn.mockRestore();
  });

  it('spawns with none when nothing is wired', () => {
    start(serviceWith(null));
    expect(engine.start).toHaveBeenCalledWith(expect.objectContaining({ pluginDirs: [] }));
  });
});

describe('restartQuery → plugin dirs', () => {
  it('a restart after stream death keeps the dirs the session started with', () => {
    const restartEngine = { start: vi.fn(async () => {}) };
    const handle = {
      agent: 'claude',
      engine: restartEngine,
      sessionId: 'sess-1',
      sessionStatus: 'error',
      turn: { status: 'idle', since: null },
      startParams: { projectPath: '/Users/test/proj', configDir: tmpConfig, pluginDirs: ['/state/mod/omnifex'] },
    } as unknown as SessionHandle;
    restartQuery('t1', handle, { sendToRenderer: vi.fn() } as unknown as RuntimeDeps);
    expect(restartEngine.start).toHaveBeenCalledWith(expect.objectContaining({ pluginDirs: ['/state/mod/omnifex'] }));
  });
});
