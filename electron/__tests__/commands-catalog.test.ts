import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCommandsCatalogService } from '../services/commands-catalog';
import { createDatabase, type Database } from '../services/database';
import { createClaudeCliEngine } from '../services/agents/claude-cli-engine';
import type { AgentEngine } from '../services/agents/types';

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

function makeFakeEngine(opts?: {
  commands?: unknown[];
  delayMs?: number;
  startReject?: Error;
}): AgentEngine {
  const defaultCommands = [
    { name: 'design-sync', description: 'Sync design tokens' },
    { name: 'commit', description: 'Make a commit' },
  ];
  const commandsToReport = opts?.commands ?? defaultCommands;
  const engine: AgentEngine = {
    kind: 'claude',
    applyExtendedPermissionMode: vi.fn(async () => {}),
    start: vi.fn(async () => {
      if (opts?.startReject) throw opts.startReject;
    }),
    send: vi.fn(async () => {}),
    sendStructured: vi.fn(async () => {}),
    sendControlRequest: vi.fn(async (subtype: string) => {
      if (subtype === 'initialize') {
        if (opts?.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        return { commands: commandsToReport };
      }
      return undefined;
    }) as AgentEngine['sendControlRequest'],
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
  return engine;
}

describe('commandsCatalogService.listSupported', () => {
  let db: Database;
  beforeEach(() => {
    mockedCreate.mockReset();
    db = createDatabase(':memory:');
  });

  function createService(opts: Parameters<typeof createCommandsCatalogService>[1] = {}) {
    return createCommandsCatalogService(db, { cliVersionFn: () => '2.1.181', ...opts });
  }

  it('returns the CLI-reported command list from the initialize control_request', async () => {
    mockedCreate.mockReturnValue(makeFakeEngine());
    const result = await createService().listSupported('/tmp/claude-config');
    expect(result).toEqual([
      { name: 'design-sync', description: 'Sync design tokens' },
      { name: 'commit', description: 'Make a commit' },
    ]);
  });

  it('passes configDir into engine.start() and closes the ephemeral engine', async () => {
    const fake = makeFakeEngine();
    mockedCreate.mockReturnValue(fake);
    await createService().listSupported('/Users/test/.claude-work');
    const callArg = (fake.start as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.configDir).toBe('/Users/test/.claude-work');
    expect(fake.close).toHaveBeenCalled();
  });

  it('returns [] and still closes the engine when start() rejects', async () => {
    const fake = makeFakeEngine({ startReject: new Error('boom') });
    mockedCreate.mockReturnValue(fake);
    const result = await createService().listSupported('/tmp/c');
    expect(result).toEqual([]);
    expect(fake.close).toHaveBeenCalled();
  });

  it('times out and returns [] if the catalog never arrives', async () => {
    mockedCreate.mockReturnValue(makeFakeEngine({ delayMs: 10_000 }));
    const result = await createService({ timeoutMs: 50 }).listSupported('/tmp/c');
    expect(result).toEqual([]);
  });
});

describe('commandsCatalogService.getCatalog (SQLite-persisted)', () => {
  const CONFIG = '/Users/test/.claude-personal';
  const FRESH = [{ name: 'design-sync', description: 'new built-in' }];
  const SEEDED = [{ name: 'commit', description: 'old' }];
  let db: Database;

  beforeEach(() => {
    mockedCreate.mockReset();
    db = createDatabase(':memory:');
  });

  function catalogRow() {
    return db.raw
      .prepare('SELECT cli_version, catalog_json, fetched_at FROM command_catalog WHERE config_dir = ?')
      .get(CONFIG) as { cli_version: string; catalog_json: string; fetched_at: string } | undefined;
  }

  it('cache miss: live-fetches, persists, and returns the catalog', async () => {
    mockedCreate.mockReturnValue(makeFakeEngine({ commands: FRESH }));
    const service = createCommandsCatalogService(db, { cliVersionFn: () => '2.1.181' });
    const result = await service.getCatalog(CONFIG);
    expect(result).toEqual(FRESH);
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    const row = catalogRow()!;
    expect(JSON.parse(row.catalog_json)).toEqual(FRESH);
    expect(row.cli_version).toBe('2.1.181');
  });

  it('cache hit: returns the persisted catalog without spawning an engine', async () => {
    const service = createCommandsCatalogService(db, { cliVersionFn: () => '2.1.181' });
    service.upsertCatalog(CONFIG, SEEDED);
    const result = await service.getCatalog(CONFIG);
    expect(result).toEqual(SEEDED);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('CLI version mismatch (e.g. after a CLI update): refetches and updates the row', async () => {
    createCommandsCatalogService(db, { cliVersionFn: () => '2.1.170' }).upsertCatalog(CONFIG, SEEDED);
    mockedCreate.mockReturnValue(makeFakeEngine({ commands: FRESH }));
    const service = createCommandsCatalogService(db, { cliVersionFn: () => '2.1.181' });
    const result = await service.getCatalog(CONFIG);
    expect(result).toEqual(FRESH); // the newly-added /design-sync now shows
    expect(catalogRow()!.cli_version).toBe('2.1.181');
  });

  it('stale row beyond TTL: serves it synchronously and refreshes in the background', async () => {
    let now = 1_000_000;
    const service = createCommandsCatalogService(db, {
      cliVersionFn: () => '2.1.181', ttlMs: 60_000, nowFn: () => now,
    });
    service.upsertCatalog(CONFIG, SEEDED);
    mockedCreate.mockReturnValue(makeFakeEngine({ commands: FRESH }));
    now += 120_000;
    expect(await service.getCatalog(CONFIG)).toEqual(SEEDED);
    await vi.waitFor(() => {
      expect(JSON.parse(catalogRow()!.catalog_json)).toEqual(FRESH);
    });
  });

  it('live fetch fails with a mismatched row: serves the stale row rather than empty', async () => {
    createCommandsCatalogService(db, { cliVersionFn: () => '2.0.0' }).upsertCatalog(CONFIG, SEEDED);
    mockedCreate.mockReturnValue(makeFakeEngine({ startReject: new Error('spawn failed') }));
    const service = createCommandsCatalogService(db, { cliVersionFn: () => '2.1.181' });
    expect(await service.getCatalog(CONFIG)).toEqual(SEEDED);
  });

  it('upsertCatalog ignores empty command lists', () => {
    createCommandsCatalogService(db, { cliVersionFn: () => '2.1.181' }).upsertCatalog(CONFIG, []);
    expect(catalogRow()).toBeUndefined();
  });
});
