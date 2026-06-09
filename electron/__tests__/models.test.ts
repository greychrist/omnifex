import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createModelsService } from '../services/models';
import { createDatabase, type Database } from '../services/database';
import { createClaudeCliEngine } from '../services/agents/claude-cli-engine';
import type { AgentEngine, InitData } from '../services/agents/types';

vi.mock('../services/agents/claude-cli-engine', () => ({
  createClaudeCliEngine: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, default: { ...actual, existsSync: vi.fn(() => true) } };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn() };
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
  const defaultModels = [
    { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Fast' },
    { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: 'Deep' },
  ];
  const modelsToReport = opts?.models ?? defaultModels;

  const engine: AgentEngine = {
    kind: 'claude',
    applyExtendedPermissionMode: vi.fn(async () => {}),
    start: vi.fn(async () => {
      if (opts?.startReject) throw opts.startReject;
      // models.ts now reads via sendControlRequest('initialize'), not via
      // onMessage(system:init). Stash initData defensively for any callers
      // that still consult getInitData(), but the live path uses the
      // control_request below.
      initData = { models: modelsToReport };
    }),
    send: vi.fn(async () => {}),
    sendStructured: vi.fn(async () => {}),
    sendControlRequest: vi.fn(async (subtype: string) => {
      if (subtype === 'initialize') {
        if (opts?.delayMs) {
          await new Promise((r) => setTimeout(r, opts.delayMs));
        }
        return { models: modelsToReport };
      }
      return undefined;
    }) as AgentEngine['sendControlRequest'],
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
  let db: Database;

  beforeEach(() => {
    mockedCreate.mockReset();
    db = createDatabase(':memory:');
  });

  function createService(opts: Parameters<typeof createModelsService>[1] = {}) {
    return createModelsService(db, { cliVersionFn: () => '2.1.170', ...opts });
  }

  it('returns the CLI-reported model list from init data', async () => {
    const fake = makeFakeEngine();
    mockedCreate.mockReturnValue(fake);

    const service = createService();
    const result = await service.listSupported('/tmp/claude-config');

    expect(result).toEqual([
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Fast' },
      { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: 'Deep' },
    ]);
  });

  it('passes configDir into engine.start()', async () => {
    const fake = makeFakeEngine();
    mockedCreate.mockReturnValue(fake);

    const service = createService();
    await service.listSupported('/Users/test/.claude-work');

    expect(fake.start).toHaveBeenCalledTimes(1);
    const callArg = (fake.start as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.configDir).toBe('/Users/test/.claude-work');
  });

  it('closes the ephemeral engine after reading models', async () => {
    const fake = makeFakeEngine();
    mockedCreate.mockReturnValue(fake);

    const service = createService();
    await service.listSupported('/tmp/claude-config');

    expect(fake.close).toHaveBeenCalled();
  });

  it('closes the engine even when start() rejects', async () => {
    const fake = makeFakeEngine({ startReject: new Error('init failed') });
    mockedCreate.mockReturnValue(fake);

    const service = createService();
    const result = await service.listSupported('/tmp/claude-config');

    expect(result).toEqual([]);
    expect(fake.close).toHaveBeenCalled();
  });

  it('returns an empty array on engine error rather than throwing', async () => {
    const fake = makeFakeEngine({ startReject: new Error('boom') });
    mockedCreate.mockReturnValue(fake);

    const service = createService();
    await expect(service.listSupported('/tmp/claude-config')).resolves.toEqual([]);
  });

  it('times out and returns empty if init never arrives', async () => {
    const fake = makeFakeEngine({ delayMs: 10_000 });
    mockedCreate.mockReturnValue(fake);

    const service = createService({ timeoutMs: 50 });
    const result = await service.listSupported('/tmp/claude-config');

    expect(result).toEqual([]);
    expect(fake.close).toHaveBeenCalled();
  });

  it('rejects a missing configDir with a clear error', async () => {
    // buildClaudeEnv runs inside engine.start(); the rejection bubbles up
    // and listSupported returns [].
    const fake = makeFakeEngine({ startReject: new Error('configDir is empty') });
    mockedCreate.mockReturnValue(fake);

    const service = createService();
    const result = await service.listSupported('');
    expect(result).toEqual([]);
  });
});

describe('modelsService.getCatalog (SQLite-persisted)', () => {
  const CONFIG = '/Users/test/.claude-personal';
  const FRESH = [
    { value: 'claude-fable-5[1m]', displayName: 'Fable 5', description: 'Most capable' },
    { value: 'sonnet', displayName: 'Sonnet', description: 'Efficient' },
  ];
  const SEEDED = [
    { value: 'default', displayName: 'Default (recommended)', description: 'Opus 4.8' },
  ];
  let db: Database;

  beforeEach(() => {
    mockedCreate.mockReset();
    db = createDatabase(':memory:');
  });

  function catalogRow() {
    return db.raw
      .prepare('SELECT cli_version, catalog_json, fetched_at FROM model_catalog WHERE config_dir = ?')
      .get(CONFIG) as { cli_version: string; catalog_json: string; fetched_at: number } | undefined;
  }

  it('cache miss: live-fetches, persists, and returns the catalog', async () => {
    mockedCreate.mockReturnValue(makeFakeEngine({ models: FRESH }));
    const service = createModelsService(db, { cliVersionFn: () => '2.1.170' });

    const result = await service.getCatalog(CONFIG);

    expect(result).toEqual(FRESH);
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    const row = catalogRow();
    expect(row).toBeTruthy();
    expect(JSON.parse(row!.catalog_json)).toEqual(FRESH);
    expect(row!.cli_version).toBe('2.1.170');
  });

  it('cache hit: returns the persisted catalog without spawning an engine', async () => {
    const service = createModelsService(db, { cliVersionFn: () => '2.1.170' });
    service.upsertCatalog(CONFIG, SEEDED);

    const result = await service.getCatalog(CONFIG);

    expect(result).toEqual(SEEDED);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('CLI version mismatch: refetches live and updates the row', async () => {
    const oldService = createModelsService(db, { cliVersionFn: () => '2.0.0' });
    oldService.upsertCatalog(CONFIG, SEEDED);

    mockedCreate.mockReturnValue(makeFakeEngine({ models: FRESH }));
    const service = createModelsService(db, { cliVersionFn: () => '2.1.170' });
    const result = await service.getCatalog(CONFIG);

    expect(result).toEqual(FRESH);
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(catalogRow()!.cli_version).toBe('2.1.170');
  });

  it('stale row: returns it immediately and refreshes in the background', async () => {
    const past = 1_000_000;
    let now = past;
    const service = createModelsService(db, {
      cliVersionFn: () => '2.1.170',
      ttlMs: 60_000,
      nowFn: () => now,
    });
    service.upsertCatalog(CONFIG, SEEDED);
    mockedCreate.mockReturnValue(makeFakeEngine({ models: FRESH }));

    now = past + 120_000; // beyond TTL
    const result = await service.getCatalog(CONFIG);
    expect(result).toEqual(SEEDED); // stale served synchronously

    await vi.waitFor(() => {
      expect(JSON.parse(catalogRow()!.catalog_json)).toEqual(FRESH);
    });
  });

  it('fresh row within TTL: no background refresh is kicked', async () => {
    const service = createModelsService(db, {
      cliVersionFn: () => '2.1.170',
      ttlMs: 60_000,
      nowFn: () => 1_000_000,
    });
    service.upsertCatalog(CONFIG, SEEDED);

    await service.getCatalog(CONFIG);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('live fetch fails on version mismatch: serves the stale row', async () => {
    const oldService = createModelsService(db, { cliVersionFn: () => '2.0.0' });
    oldService.upsertCatalog(CONFIG, SEEDED);

    mockedCreate.mockReturnValue(makeFakeEngine({ startReject: new Error('spawn failed') }));
    const service = createModelsService(db, { cliVersionFn: () => '2.1.170' });

    const result = await service.getCatalog(CONFIG);
    expect(result).toEqual(SEEDED);
  });

  it('live fetch fails with no row: returns []', async () => {
    mockedCreate.mockReturnValue(makeFakeEngine({ startReject: new Error('spawn failed') }));
    const service = createModelsService(db, { cliVersionFn: () => '2.1.170' });

    const result = await service.getCatalog(CONFIG);
    expect(result).toEqual([]);
    expect(catalogRow()).toBeUndefined();
  });

  it('unknown CLI version: an existing row matches regardless of its stored version', async () => {
    const oldService = createModelsService(db, { cliVersionFn: () => '2.0.0' });
    oldService.upsertCatalog(CONFIG, SEEDED);

    const service = createModelsService(db, { cliVersionFn: () => null });
    const result = await service.getCatalog(CONFIG);

    expect(result).toEqual(SEEDED);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('upsertCatalog ignores empty model lists', () => {
    const service = createModelsService(db, { cliVersionFn: () => '2.1.170' });
    service.upsertCatalog(CONFIG, []);
    expect(catalogRow()).toBeUndefined();
  });

  it('default version probe runs `claude --version` once and caches it', async () => {
    const { execSync } = await import('node:child_process');
    vi.mocked(execSync).mockReset().mockReturnValue('2.1.170 (Claude Code)\n');
    const service = createModelsService(db); // no cliVersionFn — real probe path

    service.upsertCatalog(CONFIG, SEEDED);
    service.upsertCatalog('/other/config', SEEDED);

    expect(catalogRow()!.cli_version).toBe('2.1.170 (Claude Code)');
    expect(vi.mocked(execSync)).toHaveBeenCalledTimes(1); // cached after first probe
  });

  it('failed version probe degrades to null: cached rows match any version', async () => {
    const { execSync } = await import('node:child_process');
    vi.mocked(execSync).mockReset().mockImplementation(() => { throw new Error('ENOENT'); });

    const seeder = createModelsService(db, { cliVersionFn: () => '1.0.0' });
    seeder.upsertCatalog(CONFIG, SEEDED);

    const service = createModelsService(db); // probe throws → version null
    const result = await service.getCatalog(CONFIG);

    expect(result).toEqual(SEEDED);
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});
