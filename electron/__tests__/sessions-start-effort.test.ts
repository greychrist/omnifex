// @vitest-environment node
//
// session_start has always carried `effort` and `thinking`, but start() handed
// the engine only model + permission mode, so the level the picker showed was
// never what a fresh session ran. Pinned here at the service seam.
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

let tmpConfig: string;
let engine: ReturnType<typeof makeFakeEngine>;

beforeEach(() => {
  engine = makeFakeEngine();
  vi.mocked(createClaudeCliEngine).mockReturnValue(engine as never);
  tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-start-effort-'));
});
afterEach(() => { fs.rmSync(tmpConfig, { recursive: true, force: true }); });

describe('sessions.start → engine.start', () => {
  it('forwards the chosen effort', () => {
    const sessions = createSessionsService(vi.fn());
    sessions.start({
      tabId: 't1',
      projectPath: '/Users/test/proj',
      configDir: tmpConfig,
      model: 'opus',
      permissionMode: 'default',
      effort: 'high',
    });
    expect(engine.start).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'opus', effort: 'high' }),
    );
  });

  it('forwards no effort when none was chosen', () => {
    const sessions = createSessionsService(vi.fn());
    sessions.start({ tabId: 't2', projectPath: '/Users/test/proj', configDir: tmpConfig, model: '', permissionMode: '' });
    const params = (engine.start.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(params.effort).toBeUndefined();
  });
});
