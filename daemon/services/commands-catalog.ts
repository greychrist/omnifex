// Never fed by live-session write-through: a long-running session's init snapshot goes stale when the CLI adds built-ins.

import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { discoverClaudeBinary } from './claude-binary';
import { createCliVersionProbe } from './cli-version-probe';
import { createClaudeCliEngine } from './agents/claude-cli-engine';
import type { Database } from './database';

export interface CommandInfo {
  name?: string;
  description?: string;
  argumentHint?: string;
  [k: string]: unknown;
}

export interface CommandsCatalogService {
  listSupported(configDir: string): Promise<CommandInfo[]>;
  getCatalog(configDir: string): Promise<CommandInfo[]>;
  upsertCatalog(configDir: string, commands: CommandInfo[]): void;
}

export interface CommandsCatalogServiceOptions {
  timeoutMs?: number;
  ttlMs?: number;
  nowFn?: () => number;
  cliVersionFn?: () => string | null;
  resolveClaudeBinary?: () => string | null;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function safeParse(json: string): CommandInfo[] | null {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v as CommandInfo[]) : null;
  } catch {
    return null;
  }
}

export function createCommandsCatalogService(
  db: Database,
  opts: CommandsCatalogServiceOptions = {},
): CommandsCatalogService {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.nowFn ?? Date.now;
  const resolveClaudeBinary = opts.resolveClaudeBinary ?? discoverClaudeBinary;

  const cliVersion = opts.cliVersionFn ?? createCliVersionProbe({ resolveBinary: resolveClaudeBinary });

  async function listSupported(configDir: string): Promise<CommandInfo[]> {
    const binaryPath = resolveClaudeBinary();
    if (!binaryPath) {
      console.error('[commands] listSupported: claude binary not found');
      return [];
    }

    const engine = createClaudeCliEngine({
      tabId: `commands-${Date.now().toString(36)}`,
      claudeBinaryPath: binaryPath,
    });

    try {
      // tmpdir: the catalog comes from `initialize`, not the project, and it doesn't leak the user's cwd.
      await engine.start({
        projectPath: os.tmpdir(),
        configDir,
        sessionId: randomUUID(),
        resume: false,
      });

      const resp = await Promise.race([
        engine.sendControlRequest<{ commands?: unknown[] }>('initialize'),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      const commands = (resp)?.commands;
      return Array.isArray(commands) ? (commands as CommandInfo[]) : [];
    } catch (err) {
      console.error('[commands] listSupported failed:', err);
      return [];
    } finally {
      try { await engine.close(); } catch { /* best effort */ }
    }
  }

  function upsertCatalog(configDir: string, commands: CommandInfo[]): void {
    if (!configDir || commands.length === 0) return;
    try {
      db.raw.prepare(
        `INSERT INTO command_catalog (config_dir, cli_version, catalog_json, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(config_dir) DO UPDATE SET
           cli_version = excluded.cli_version,
           catalog_json = excluded.catalog_json,
           fetched_at = excluded.fetched_at`,
      ).run(configDir, cliVersion() ?? '', JSON.stringify(commands, null, 2), new Date(now()).toISOString());
    } catch (err) {
      console.error('[commands] upsertCatalog failed:', err);
    }
  }

  const refreshing = new Set<string>();
  async function refresh(configDir: string): Promise<CommandInfo[]> {
    if (refreshing.has(configDir)) return [];
    refreshing.add(configDir);
    try {
      const commands = await listSupported(configDir);
      if (commands.length > 0) upsertCatalog(configDir, commands);
      return commands;
    } finally {
      refreshing.delete(configDir);
    }
  }

  async function getCatalog(configDir: string): Promise<CommandInfo[]> {
    const row = db.raw
      .prepare('SELECT cli_version, catalog_json, fetched_at FROM command_catalog WHERE config_dir = ?')
      .get(configDir) as
      | { cli_version: string; catalog_json: string; fetched_at: string }
      | undefined;
    const ver = cliVersion();
    const rowCommands = row ? safeParse(row.catalog_json) : null;

    if (row && rowCommands && (ver === null || row.cli_version === ver)) {
      if (now() - Date.parse(row.fetched_at) > ttlMs) {
        void refresh(configDir).catch((err: unknown) => {
          console.error('[commands] background refresh failed:', err);
        });
      }
      return rowCommands;
    }

    const fresh = await refresh(configDir);
    if (fresh.length > 0) return fresh;
    return rowCommands ?? [];
  }

  return { listSupported, getCatalog, upsertCatalog };
}
