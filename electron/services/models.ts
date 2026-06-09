// Standalone model-catalog service — answers "which models can this account
// use?" for a given CLAUDE_CONFIG_DIR without requiring a live session.
//
// The catalog is persisted to SQLite (`model_catalog`, migration v12) so the
// renderer's pickers are warm at app start. Rows are keyed by config dir and
// invalidated when the CLI version changes; rows older than the TTL are
// served immediately while a background refresh runs. Cold/invalidated
// lookups fall back to the live fetch: a short-lived ClaudeCliEngine whose
// `initialize` control_request returns the model catalog. Live sessions also
// write their init-time catalog through `upsertCatalog` (see
// sessions/runtime.ts), so accounts in active use never need the ephemeral
// spawn. The tab-scoped sessions.getSupportedModels path still covers the
// in-session case.

import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { findBundledSdkBinaryAuto } from './claude-binary';
import { createClaudeCliEngine } from './agents/claude-cli-engine';
import type { Database } from './database';

export interface ModelInfo {
  /** Stable model identifier (e.g. "claude-sonnet-4-6"). */
  value?: string;
  /** Display name shown in the picker. */
  displayName?: string;
  /** Optional one-line description. */
  description?: string;
  [k: string]: unknown;
}

export interface ModelsService {
  /** Live ephemeral-engine fetch. Prefer getCatalog(), which caches. */
  listSupported(configDir: string): Promise<ModelInfo[]>;
  /** Cached catalog: persisted row when valid, live fetch otherwise. */
  getCatalog(configDir: string): Promise<ModelInfo[]>;
  /** Persist a catalog (live-session write-through and internal refresh). */
  upsertCatalog(configDir: string, models: ModelInfo[]): void;
}

export interface ModelsServiceOptions {
  /** Max ms to wait for the CLI init handshake before giving up. */
  timeoutMs?: number;
  /** Row age before a background refresh is kicked. Default 24 h. */
  ttlMs?: number;
  /** Injectable clock for tests. Default Date.now. */
  nowFn?: () => number;
  /**
   * Injectable CLI-version probe for tests. Default runs `claude --version`
   * on the resolved binary once and caches it for the service lifetime.
   * `null` means "undeterminable" — cached rows then match any version.
   */
  cliVersionFn?: () => string | null;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function findSystemClaudeBinary(): string | null {
  const candidates = [
    `${os.homedir()}/.local/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Legacy fallback — the per-platform binary bundled in the
  // @anthropic-ai/claude-agent-sdk npm package. Returns null on most
  // installs; kept for back-compat with old install layouts.
  return findBundledSdkBinaryAuto();
}

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

  let cachedVersion: string | null | undefined;
  function cliVersion(): string | null {
    if (opts.cliVersionFn) return opts.cliVersionFn();
    if (cachedVersion !== undefined) return cachedVersion;
    const binaryPath = findSystemClaudeBinary();
    if (!binaryPath) {
      cachedVersion = null;
      return cachedVersion;
    }
    try {
      const out = execSync(`"${binaryPath}" --version`, { encoding: 'utf8', timeout: 5000 });
      cachedVersion = out.trim() || null;
    } catch {
      cachedVersion = null;
    }
    return cachedVersion;
  }

  async function listSupported(configDir: string): Promise<ModelInfo[]> {
    const binaryPath = findSystemClaudeBinary();
    if (!binaryPath) {
      console.error('[models] listSupported: claude binary not found');
      return [];
    }

    const engine = createClaudeCliEngine({
      tabId: `models-${Date.now().toString(36)}`,
      claudeBinaryPath: binaryPath,
    });

    try {
      // cwd is best-effort: anything readable will do — the CLI won't read
      // the project on this handshake. tmpdir is universal and doesn't leak
      // the user's working directory into the request.
      await engine.start({
        projectPath: os.tmpdir(),
        configDir,
        sessionId: randomUUID(),
        resume: false,
      });

      // Drive the CLI's `initialize` control_request to get the
      // model catalog back. The CLI returns model/command/agent catalogs
      // in the control_response — no need to send a user message and wait
      // for system:init.
      const resp = await Promise.race([
        engine.sendControlRequest<{ models?: unknown[] }>('initialize'),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      const models = (resp as { models?: unknown[] } | null)?.models;
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
      ).run(configDir, cliVersion() ?? '', JSON.stringify(models), now());
    } catch (err) {
      console.error('[models] upsertCatalog failed:', err);
    }
  }

  // One in-flight refresh per config dir — getCatalog may fire refreshes in
  // the background, and overlapping ephemeral engine spawns for the same
  // account are pure waste.
  const refreshing = new Set<string>();
  async function refresh(configDir: string): Promise<ModelInfo[]> {
    if (refreshing.has(configDir)) return [];
    refreshing.add(configDir);
    try {
      const models = await listSupported(configDir);
      if (models.length > 0) upsertCatalog(configDir, models);
      return models;
    } finally {
      refreshing.delete(configDir);
    }
  }

  async function getCatalog(configDir: string): Promise<ModelInfo[]> {
    const row = db.raw
      .prepare('SELECT cli_version, catalog_json, fetched_at FROM model_catalog WHERE config_dir = ?')
      .get(configDir) as
      | { cli_version: string; catalog_json: string; fetched_at: number }
      | undefined;
    const ver = cliVersion();
    const rowModels = row ? safeParse(row.catalog_json) : null;

    if (row && rowModels && (ver === null || row.cli_version === ver)) {
      if (now() - row.fetched_at > ttlMs) {
        void refresh(configDir).catch((err: unknown) => {
          console.error('[models] background refresh failed:', err);
        });
      }
      return rowModels;
    }

    const fresh = await refresh(configDir);
    if (fresh.length > 0) return fresh;
    // Live fetch failed — a stale/mismatched row beats an empty picker.
    return rowModels ?? [];
  }

  return { listSupported, getCatalog, upsertCatalog };
}
