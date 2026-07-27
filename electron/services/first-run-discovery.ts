// First-time account discovery — populates the account list on the user's
// first launch of OmniFex so the AccountPickerDialog isn't an empty void when
// they try to open a project.
//
// Design constraints (from CLAUDE.md):
//   - No silent default-account fallback. Resolution stays override → rule →
//     null. Discovery only puts entries IN the list; it does not pick one for
//     the user, set an `isDefault` flag, or auto-create path rules.
//   - Runs once and only once per OmniFex install. Stored as the
//     `discovery_completed` app_setting. If the user later deletes every
//     account in Settings, we don't silently re-create them — let them be
//     deliberate. (Manual escape hatch lives in the "Scan for accounts"
//     button in Settings → Accounts.)
//
// Discovery is engine-aware: it scans for both Claude (`~/.claude*`) and Codex
// (`~/.codex*`) config dirs and tags each with its engine so the created
// account row routes to the right CLI.
//
// The caller (electron/main.ts) supplies the `discover` function, which in
// production is `accountsService.discoverAccounts`. Injectable for tests.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AccountsService, AccountEngine } from './accounts';
import type { Database } from './database';

const DISCOVERY_FLAG_KEY = 'discovery_completed';

export interface DiscoveredConfigDir {
  /** The bare directory name, e.g. `.claude-work` or `.codex`. */
  dirName: string;
  /** Absolute path to the config dir. */
  configDir: string;
  engine: AccountEngine;
}

export interface FirstTimeDiscoveryDeps {
  accounts: Pick<AccountsService, 'listAccounts' | 'createAccount'>;
  db: Pick<Database, 'getSetting' | 'saveSetting'>;
  /** Returns the engine-tagged config dirs to seed accounts from. */
  discover: () => Promise<DiscoveredConfigDir[]>;
  /**
   * Reads the OAuth identity for a config dir so discovered accounts get their
   * expected email prefilled — account email verification then works without
   * the user typing anything. Injectable for tests; main passes
   * `readOauthIdentity` from services/account-identity.ts. Omitted means no
   * prefill (accounts are created with expected_email = null, i.e. no check).
   */
  readIdentity?: (configDir: string) => { email: string | null } | null;
}

export interface FirstTimeDiscoveryResult {
  /** True if discovery actually ran this call (vs. skipped due to existing
   *  accounts or the completed flag). */
  ran: boolean;
  created: Array<{ name: string; configDir: string; engine: AccountEngine }>;
}

export async function runFirstTimeDiscovery(
  deps: FirstTimeDiscoveryDeps,
): Promise<FirstTimeDiscoveryResult> {
  if (deps.db.getSetting(DISCOVERY_FLAG_KEY) === 'true') {
    return { ran: false, created: [] };
  }
  if (deps.accounts.listAccounts().length > 0) {
    // Some accounts already exist (e.g. user upgraded from a build that
    // pre-dated this feature). Don't run discovery, but also don't set the
    // flag — if they later delete everything we still won't re-run (because
    // listAccounts > 0 is just one of two gates), but we keep the option of
    // re-running explicitly via the Settings escape hatch.
    return { ran: false, created: [] };
  }

  const found = await deps.discover();
  const created: Array<{ name: string; configDir: string; engine: AccountEngine }> = [];
  for (const { dirName, configDir, engine } of found) {
    const name = nameFromConfigDir(dirName, engine);
    // Claude only — Codex identity lives in ~/.codex/auth.json and is already
    // surfaced by codexAuth.getStatus, so there's nothing to prefill here.
    const expectedEmail =
      engine === 'claude' ? (deps.readIdentity?.(configDir)?.email ?? null) : null;
    deps.accounts.createAccount({ name, configDir, engine, expectedEmail });
    created.push({ name, configDir, engine });
  }

  deps.db.saveSetting(DISCOVERY_FLAG_KEY, 'true');
  return { ran: true, created };
}

const ENGINE_PREFIXES: ReadonlyArray<readonly [string, AccountEngine]> = [
  ['.claude', 'claude'],
  ['.codex', 'codex'],
];

/**
 * Classify a home-directory entry name as a Claude/Codex config dir, or null
 * if it isn't one. The post-prefix character must be the end of the string or
 * a `-`/`_` separator, so false positives like `.claudette` / `.codexample`
 * are excluded.
 */
export function engineFromDirName(name: string): AccountEngine | null {
  for (const [prefix, engine] of ENGINE_PREFIXES) {
    if (name === prefix) return engine;
    if (name.startsWith(`${prefix}-`) || name.startsWith(`${prefix}_`)) return engine;
  }
  return null;
}

/**
 * Scan a home directory for Claude and Codex config dirs, tagging each with its
 * engine. Returns [] if the directory can't be read.
 */
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

/**
 * Derive a human-readable account name from a config directory name, given its
 * engine.
 *
 *   (.claude, claude)        → "Claude"
 *   (.claude-work, claude)   → "Work"
 *   (.codex, codex)          → "Codex"
 *   (.codex-work, codex)     → "Work"
 *   (.codex-side_project, …) → "Side Project"
 *
 * Users can rename in Settings → Accounts; this is only the starting label.
 */
export function nameFromConfigDir(dirName: string, engine: AccountEngine): string {
  const prefix = engine === 'claude' ? '.claude' : '.codex';
  const suffix = dirName === prefix ? engine : dirName.slice(prefix.length + 1);
  return suffix
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
