// Runs once per install (`discovery_completed`). Never picks an account, sets a default or creates path rules.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AccountsService, AccountEngine } from './accounts';
import type { Database } from './database';

const DISCOVERY_FLAG_KEY = 'discovery_completed';

export interface DiscoveredConfigDir {
  dirName: string;
  configDir: string;
  engine: AccountEngine;
}

export interface FirstTimeDiscoveryDeps {
  accounts: Pick<AccountsService, 'listAccounts' | 'createAccount'>;
  db: Pick<Database, 'getSetting' | 'saveSetting'>;
  discover: () => Promise<DiscoveredConfigDir[]>;
  readIdentity?: (configDir: string) => { email: string | null } | null;
}

export interface FirstTimeDiscoveryResult {
  ran: boolean;
  created: { name: string; configDir: string; engine: AccountEngine }[];
}

export async function runFirstTimeDiscovery(
  deps: FirstTimeDiscoveryDeps,
): Promise<FirstTimeDiscoveryResult> {
  if (deps.db.getSetting(DISCOVERY_FLAG_KEY) === 'true') {
    return { ran: false, created: [] };
  }
  if (deps.accounts.listAccounts().length > 0) {
    return { ran: false, created: [] };
  }

  const found = await deps.discover();
  const created: { name: string; configDir: string; engine: AccountEngine }[] = [];
  for (const { dirName, configDir, engine } of found) {
    const name = nameFromConfigDir(dirName, engine);
    const expectedEmail =
      engine === 'claude' ? (deps.readIdentity?.(configDir)?.email ?? null) : null;
    deps.accounts.createAccount({ name, configDir, engine, expectedEmail });
    created.push({ name, configDir, engine });
  }

  deps.db.saveSetting(DISCOVERY_FLAG_KEY, 'true');
  return { ran: true, created };
}

const ENGINE_PREFIXES: readonly (readonly [string, AccountEngine])[] = [
  ['.claude', 'claude'],
  ['.codex', 'codex'],
];

/** The prefix must end the name or be followed by `-`/`_`, so `.claudette` is not a config dir. */
export function engineFromDirName(name: string): AccountEngine | null {
  for (const [prefix, engine] of ENGINE_PREFIXES) {
    if (name === prefix) return engine;
    if (name.startsWith(`${prefix}-`) || name.startsWith(`${prefix}_`)) return engine;
  }
  return null;
}

export async function discoverConfigDirs(homeDir: string): Promise<DiscoveredConfigDir[]> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(homeDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: DiscoveredConfigDir[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const engine = engineFromDirName(entry.name);
    if (!engine) continue;
    found.push({
      dirName: entry.name,
      configDir: path.join(homeDir, entry.name),
      engine,
    });
  }
  return found;
}

export function nameFromConfigDir(dirName: string, engine: AccountEngine): string {
  const prefix = engine === 'claude' ? '.claude' : '.codex';
  const suffix = dirName === prefix ? engine : dirName.slice(prefix.length + 1);
  return suffix
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
