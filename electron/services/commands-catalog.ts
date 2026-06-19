// Standalone slash-command-catalog service — answers "which slash commands can
// this account use?" for a given CLAUDE_CONFIG_DIR without requiring a live
// session.
//
// Mirrors models.ts. The catalog is persisted to SQLite (`command_catalog`,
// migration v14) so the renderer's slash-command picker is warm at app start.
// Rows are keyed by config dir and invalidated when the CLI version changes;
// rows older than the TTL are served immediately while a background refresh
// runs. Cold/invalidated lookups fall back to the live fetch: a short-lived
// ClaudeCliEngine whose `initialize` control_request returns the command
// catalog (alongside models/agents).
//
// Why this is NOT fed by live-session write-through the way models are: the bug
// this fixes is that a long-running session's init-time command snapshot goes
// stale when the CLI gains new built-ins (e.g. /design-sync after a CLI
// update). Persisting that stale snapshot would defeat the purpose, so commands
// are only ever sourced from a fresh ephemeral `initialize` — which always runs
// the current binary and reports the current catalog.

import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { findBundledSdkBinaryAuto } from './claude-binary';
import { createClaudeCliEngine } from './agents/claude-cli-engine';
import type { Database } from './database';

export interface CommandInfo {
  /** Command name without the leading slash (e.g. "design-sync"). */
  name?: string;
  /** Optional one-line description shown in the picker. */
  description?: string;
  /** Optional argument hint string, when the command takes arguments. */
  argumentHint?: string;
  [k: string]: unknown;
}

export interface CommandsCatalogService {
  /** Live ephemeral-engine fetch. Prefer getCatalog(), which caches. */
  listSupported(configDir: string): Promise<CommandInfo[]>;
  /** Cached catalog: persisted row when valid, live fetch otherwise. */
  getCatalog(configDir: string): Promise<CommandInfo[]>;
  /** Persist a catalog (internal refresh write-back). */
  upsertCatalog(configDir: string, commands: CommandInfo[]): void;
}

export interface CommandsCatalogServiceOptions {
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
  return findBundledSdkBinaryAuto();
}

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

  async function listSupported(configDir: string): Promise<CommandInfo[]> {
    const binaryPath = findSystemClaudeBinary();
    if (!binaryPath) {
      console.error('[commands] listSupported: claude binary not found');
      return [];
    }

    const engine = createClaudeCliEngine({
      tabId: `commands-${Date.now().toString(36)}`,
      claudeBinaryPath: binaryPath,
    });

    try {
      // cwd is best-effort: anything readable will do — the catalog comes back
      // in the `initialize` control_response, not from reading the project.
      // tmpdir is universal and doesn't leak the user's working directory.
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
      const commands = (resp as { commands?: unknown[] } | null)?.commands;
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
      // Pretty-printed JSON + ISO timestamp: the row is a debugging surface
      // (DB browsers, support bundles), so keep it human-readable.
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

  // One in-flight refresh per config dir — getCatalog may fire refreshes in
  // the background, and overlapping ephemeral engine spawns for the same
  // account are pure waste.
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
      // NaN from an unparseable timestamp fails the > comparison, which
      // degrades to "no background refresh" — acceptable for a cache row.
      if (now() - Date.parse(row.fetched_at) > ttlMs) {
        void refresh(configDir).catch((err: unknown) => {
          console.error('[commands] background refresh failed:', err);
        });
      }
      return rowCommands;
    }

    const fresh = await refresh(configDir);
    if (fresh.length > 0) return fresh;
    // Live fetch failed — a stale/mismatched row beats an empty picker.
    return rowCommands ?? [];
  }

  return { listSupported, getCatalog, upsertCatalog };
}
