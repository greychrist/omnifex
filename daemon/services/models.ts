import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { discoverClaudeBinary } from './claude-binary';
import { createCliVersionProbe } from './cli-version-probe';
import { createClaudeCliEngine } from './agents/claude-cli-engine';
import type { Database } from './database';

export interface ModelInfo {
  value?: string;
  displayName?: string;
  description?: string;
  [k: string]: unknown;
}

export interface ModelsService {
  listSupported(configDir: string): Promise<ModelInfo[]>;
  getCatalog(configDir: string): Promise<ModelInfo[]>;
  refreshCatalog(configDir: string): Promise<ModelInfo[]>;
  upsertCatalog(configDir: string, models: ModelInfo[]): void;
}

export interface ModelsServiceOptions {
  timeoutMs?: number;
  ttlMs?: number;
  nowFn?: () => number;
  cliVersionFn?: () => string | null;
  resolveClaudeBinary?: () => string | null;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function safeParse(json: string): ModelInfo[] | null {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v as ModelInfo[]) : null;
  } catch {
    return null;
  }
}

export function createModelsService(db: Database, opts: ModelsServiceOptions = {}): ModelsService {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.nowFn ?? Date.now;
  const resolveClaudeBinary = opts.resolveClaudeBinary ?? discoverClaudeBinary;

  const cliVersion = opts.cliVersionFn ?? createCliVersionProbe({ resolveBinary: resolveClaudeBinary });

  async function listSupported(configDir: string): Promise<ModelInfo[]> {
    const binaryPath = resolveClaudeBinary();
    if (!binaryPath) {
      console.error('[models] listSupported: claude binary not found');
      return [];
    }

    const engine = createClaudeCliEngine({
      tabId: `models-${Date.now().toString(36)}`,
      claudeBinaryPath: binaryPath,
    });

    try {
      // tmpdir: the CLI doesn't read the project on this handshake, and it doesn't leak the user's cwd.
      await engine.start({
        projectPath: os.tmpdir(),
        configDir,
        sessionId: randomUUID(),
        resume: false,
      });

      const resp = await Promise.race([
        engine.sendControlRequest<{ models?: unknown[] }>('initialize'),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      const models = (resp)?.models;
      return Array.isArray(models) ? (models as ModelInfo[]) : [];
    } catch (err) {
      console.error('[models] listSupported failed:', err);
      return [];
    } finally {
      try { await engine.close(); } catch { /* best effort */ }
    }
  }

  function upsertCatalog(configDir: string, models: ModelInfo[]): void {
    if (!configDir || models.length === 0) return;
    try {
      db.raw.prepare(
        `INSERT INTO model_catalog (config_dir, cli_version, catalog_json, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(config_dir) DO UPDATE SET
           cli_version = excluded.cli_version,
           catalog_json = excluded.catalog_json,
           fetched_at = excluded.fetched_at`,
      ).run(configDir, cliVersion() ?? '', JSON.stringify(models, null, 2), new Date(now()).toISOString());
    } catch (err) {
      console.error('[models] upsertCatalog failed:', err);
    }
  }

  const inFlight = new Map<string, Promise<ModelInfo[]>>();
  function refresh(configDir: string): Promise<ModelInfo[]> {
    const pending = inFlight.get(configDir);
    if (pending) return pending;
    const p = (async () => {
      try {
        const models = await listSupported(configDir);
        if (models.length > 0) upsertCatalog(configDir, models);
        return models;
      } finally {
        inFlight.delete(configDir);
      }
    })();
    inFlight.set(configDir, p);
    return p;
  }

  function readRow(configDir: string): { cli_version: string; catalog_json: string; fetched_at: string } | undefined {
    return db.raw
      .prepare('SELECT cli_version, catalog_json, fetched_at FROM model_catalog WHERE config_dir = ?')
      .get(configDir) as { cli_version: string; catalog_json: string; fetched_at: string } | undefined;
  }

  async function refreshCatalog(configDir: string): Promise<ModelInfo[]> {
    const fresh = await refresh(configDir);
    if (fresh.length > 0) return fresh;
    const row = readRow(configDir);
    return (row ? safeParse(row.catalog_json) : null) ?? [];
  }

  async function getCatalog(configDir: string): Promise<ModelInfo[]> {
    const row = readRow(configDir);
    const ver = cliVersion();
    const rowModels = row ? safeParse(row.catalog_json) : null;

    if (row && rowModels && (ver === null || row.cli_version === ver)) {
      if (now() - Date.parse(row.fetched_at) > ttlMs) {
        void refresh(configDir).catch((err: unknown) => {
          console.error('[models] background refresh failed:', err);
        });
      }
      return rowModels;
    }

    const fresh = await refresh(configDir);
    if (fresh.length > 0) return fresh;
    return rowModels ?? [];
  }

  return { listSupported, getCatalog, refreshCatalog, upsertCatalog };
}
