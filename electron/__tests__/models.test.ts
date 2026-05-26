import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createModelsService } from '../services/models';
import { createClaudeCliEngine } from '../services/agents/claude-cli-engine';
import type { AgentEngine, InitData } from '../services/agents/types';

vi.mock('../services/agents/claude-cli-engine', () => ({
  createClaudeCliEngine: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, default: { ...actual, existsSync: vi.fn(() => true) } };
});

const mockedCreate = vi.mocked(createClaudeCliEngine);

interface FakeEngine extends AgentEngine {
  _emitInit: (init: InitData) => void;
  _emitExit: () => void;
}

function makeFakeEngine(opts?: {
  models?: unknown[];
  delayMs?: number;
  startReject?: Error;
}): FakeEngine {
  const messageCbs: Array<(m: { agent: 'claude'; tabId: string; receivedAt: string; sessionId: string | null; payload: unknown }) => void> = [];
  const exitCbs: Array<() => void> = [];
  let initData: InitData | null = null;

  const engine: AgentEngine = {
    kind: 'claude',
    applyExtendedPermissionMode: vi.fn(async () => {}),
    start: vi.fn(async () => {
      if (opts?.startReject) throw opts.startReject;
      if (opts?.delayMs) {
        // Schedule the init emission asynchronously so the listSupported
        // race against the timeout exercises both branches.
        setTimeout(() => {
          initData = { models: opts.models ?? [] };
          for (const cb of messageCbs) {
            cb({ agent: 'claude', tabId: 't', receivedAt: '', sessionId: 's', payload: { type: 'system', subtype: 'init' } });
          }
        }, opts.delayMs);
      } else {
        // Emit init synchronously (default behavior).
        initData = { models: opts?.models ?? [
          { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Fast' },
          { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: 'Deep' },
        ] };
        queueMicrotask(() => {
          for (const cb of messageCbs) {
            cb({ agent: 'claude', tabId: 't', receivedAt: '', sessionId: 's', payload: { type: 'system', subtype: 'init' } });
          }
        });
      }
    }),
    send: vi.fn(async () => {}),
    sendStructured: vi.fn(async () => {}),
    sendControlRequest: vi.fn(async () => undefined) as AgentEngine['sendControlRequest'],
    respondPermission: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    kill: vi.fn(),
    getResumeId: vi.fn(() => null),
    getInitData: vi.fn(() => initData),
    onMessage: vi.fn((cb) => {
      messageCbs.push(cb);
      return { dispose() { const i = messageCbs.indexOf(cb); if (i !== -1) messageCbs.splice(i, 1); } };
    }),
    onPermissionRequest: vi.fn(() => ({ dispose() {} })),
    onError: vi.fn(() => ({ dispose() {} })),
    onExit: vi.fn((cb) => {
      exitCbs.push(cb);
      return { dispose() { const i = exitCbs.indexOf(cb); if (i !== -1) exitCbs.splice(i, 1); } };
    }),
  };
  const fake = engine as FakeEngine;
  fake._emitInit = (init) => {
    initData = init;
    for (const cb of messageCbs) {
      cb({ agent: 'claude', tabId: 't', receivedAt: '', sessionId: 's', payload: { type: 'system', subtype: 'init' } });
    }
  };
  fake._emitExit = () => {
    for (const cb of exitCbs) cb();
  };
  return fake;
}

describe('modelsService.listSupported', () => {
  beforeEach(() => {
    mockedCreate.mockReset();
  });

  it('returns the CLI-reported model list from init data', async () => {
    const fake = makeFakeEngine();
    mockedCreate.mockReturnValue(fake);

    const service = createModelsService();
    const result = await service.listSupported('/tmp/claude-config');

    expect(result).toEqual([
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Fast' },
      { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: 'Deep' },
    ]);
  });

  it('passes configDir into engine.start()', async () => {
    const fake = makeFakeEngine();
    mockedCreate.mockReturnValue(fake);

    const service = createModelsService();
    await service.listSupported('/Users/test/.claude-work');

    expect(fake.start).toHaveBeenCalledTimes(1);
    const callArg = (fake.start as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.configDir).toBe('/Users/test/.claude-work');
  });

  it('closes the ephemeral engine after reading models', async () => {
    const fake = makeFakeEngine();
    mockedCreate.mockReturnValue(fake);

    const service = createModelsService();
    await service.listSupported('/tmp/claude-config');

    expect(fake.close).toHaveBeenCalled();
  });

  it('closes the engine even when start() rejects', async () => {
    const fake = makeFakeEngine({ startReject: new Error('init failed') });
    mockedCreate.mockReturnValue(fake);

    const service = createModelsService();
    const result = await service.listSupported('/tmp/claude-config');

    expect(result).toEqual([]);
    expect(fake.close).toHaveBeenCalled();
  });

  it('returns an empty array on engine error rather than throwing', async () => {
    const fake = makeFakeEngine({ startReject: new Error('boom') });
    mockedCreate.mockReturnValue(fake);

    const service = createModelsService();
    await expect(service.listSupported('/tmp/claude-config')).resolves.toEqual([]);
  });

  it('times out and returns empty if init never arrives', async () => {
    const fake = makeFakeEngine({ delayMs: 10_000 });
    mockedCreate.mockReturnValue(fake);

    const service = createModelsService({ timeoutMs: 50 });
    const result = await service.listSupported('/tmp/claude-config');

    expect(result).toEqual([]);
    expect(fake.close).toHaveBeenCalled();
  });

  it('rejects a missing configDir with a clear error', async () => {
    // buildClaudeEnv runs inside engine.start(); the rejection bubbles up
    // and listSupported returns [].
    const fake = makeFakeEngine({ startReject: new Error('configDir is empty') });
    mockedCreate.mockReturnValue(fake);

    const service = createModelsService();
    const result = await service.listSupported('');
    expect(result).toEqual([]);
  });
});
