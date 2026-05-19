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
//     deliberate. (Manual escape hatch lives in the "Scan for Claude config
//     directories" button in Settings → Accounts.)
//
// The caller (electron/main.ts) supplies the `discover` function, which in
// production is `accountsService.discoverAccounts`. Injectable for tests.

import type { AccountsService } from './accounts';
import type { Database } from './database';

const DISCOVERY_FLAG_KEY = 'discovery_completed';

export interface FirstTimeDiscoveryDeps {
  accounts: Pick<AccountsService, 'listAccounts' | 'createAccount'>;
  db: Pick<Database, 'getSetting' | 'saveSetting'>;
  /** Returns [dirName, absolutePath] tuples for every `~/.claude*` dir. */
  discover: () => Promise<Array<[string, string]>>;
}

export interface FirstTimeDiscoveryResult {
  /** True if discovery actually ran this call (vs. skipped due to existing
   *  accounts or the completed flag). */
  ran: boolean;
  created: Array<{ name: string; configDir: string }>;
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
  const created: Array<{ name: string; configDir: string }> = [];
  for (const [dirName, configDir] of found) {
    const name = nameFromConfigDir(dirName);
    deps.accounts.createAccount(name, configDir);
    created.push({ name, configDir });
  }

  deps.db.saveSetting(DISCOVERY_FLAG_KEY, 'true');
  return { ran: true, created };
}

/**
 * Derive a human-readable account name from a `.claude*` directory name.
 *
 *   .claude              → "Claude"
 *   .claude-work         → "Work"
 *   .claude-personal     → "Personal"
 *   .claude-work-prod    → "Work Prod"
 *   .claude-side_project → "Side Project"
 *
 * Users can rename in Settings → Accounts; this is only the starting label.
 */
export function nameFromConfigDir(dirName: string): string {
  const suffix = dirName === '.claude' ? 'claude' : dirName.slice('.claude-'.length);
  return suffix
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
