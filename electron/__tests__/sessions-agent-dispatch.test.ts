// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

// Shared stub engine factory so we can inspect call counts on each factory
// independently. Both factories return the same shape — the only thing
// under test here is which factory got picked.
function makeStubEngine(kind: 'claude' | 'codex'): unknown {
  return {
    kind,
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
  };
}

vi.mock('../services/agents/claude-cli-engine', () => ({
  createClaudeCliEngine: vi.fn(() => makeStubEngine('claude')),
}));

vi.mock('../services/agents/codex-cli-engine', () => ({
  createCodexCliEngine: vi.fn(() => makeStubEngine('codex')),
}));

vi.mock('../services/sessions/binary', () => ({
  findSystemClaudeBinary: vi.fn(() => '/usr/local/bin/claude'),
  findSystemCodexBinary: vi.fn(() => '/usr/local/bin/codex'),
}));

import { createSessionsService } from '../services/sessions';
import { createClaudeCliEngine } from '../services/agents/claude-cli-engine';
import { createCodexCliEngine } from '../services/agents/codex-cli-engine';
import {
  findSystemClaudeBinary,
  findSystemCodexBinary,
} from '../services/sessions/binary';

describe('sessions.start — engine factory dispatch on params.agent', () => {
  const baseParams = {
    tabId: 'tab-dispatch',
    projectPath: '/Users/test/proj',
    configDir: '/cfg',
    model: '',
    permissionMode: '',
  } as const;

  it("agent: 'claude' calls createClaudeCliEngine (and not Codex)", () => {
    vi.mocked(createClaudeCliEngine).mockClear();
    vi.mocked(createCodexCliEngine).mockClear();

    const sessions = createSessionsService(vi.fn());
    sessions.start({ ...baseParams, agent: 'claude' });

    expect(createClaudeCliEngine).toHaveBeenCalledTimes(1);
    expect(createCodexCliEngine).not.toHaveBeenCalled();
    expect(vi.mocked(findSystemClaudeBinary)).toHaveBeenCalled();
  });

  it("agent: 'codex' calls createCodexCliEngine (and not Claude)", () => {
    vi.mocked(createClaudeCliEngine).mockClear();
    vi.mocked(createCodexCliEngine).mockClear();
    vi.mocked(findSystemCodexBinary).mockClear();

    const sessions = createSessionsService(vi.fn());
    sessions.start({ ...baseParams, agent: 'codex' });

    expect(createCodexCliEngine).toHaveBeenCalledTimes(1);
    expect(createClaudeCliEngine).not.toHaveBeenCalled();
    expect(vi.mocked(findSystemCodexBinary)).toHaveBeenCalled();
    // Codex factory must receive the resolved binary path
    expect(vi.mocked(createCodexCliEngine)).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-dispatch',
        codexBinaryPath: '/usr/local/bin/codex',
      }),
    );
  });

  it('no agent param defaults to claude (back-compat)', () => {
    vi.mocked(createClaudeCliEngine).mockClear();
    vi.mocked(createCodexCliEngine).mockClear();

    const sessions = createSessionsService(vi.fn());
    sessions.start({ ...baseParams });

    expect(createClaudeCliEngine).toHaveBeenCalledTimes(1);
    expect(createCodexCliEngine).not.toHaveBeenCalled();
  });

  it("agent: 'codex' surfaces a clean error when the codex binary is missing", () => {
    vi.mocked(createClaudeCliEngine).mockClear();
    vi.mocked(createCodexCliEngine).mockClear();
    vi.mocked(findSystemCodexBinary).mockReturnValueOnce(null);

    const send = vi.fn();
    const sessions = createSessionsService(send);
    sessions.start({ ...baseParams, agent: 'codex' });

    expect(createCodexCliEngine).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      'session-status:tab-dispatch',
      expect.objectContaining({ sessionStatus: 'error' }),
    );
    expect(send).toHaveBeenCalledWith(
      'claude-error:tab-dispatch',
      expect.stringContaining('codex'),
    );
  });
});
