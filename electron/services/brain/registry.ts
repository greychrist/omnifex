import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Database } from '../database';
import { createVault, type Vault } from './vault';
import { createVaultIndex, type SearchHit, type SearchOptions, type VaultIndex } from './search';
import { createVaultGit, type VaultGit } from './git';
import { fireAndLogGitFailure } from './git-logging';
import { canonicalPath } from './paths';
import type { ParsedNote } from './types';

/** Thrown when a vault path is already claimed by a different account. */
export class VaultConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultConflictError';
  }
}

/** app_settings key holding one account's vault root. */
export function vaultSettingKey(accountId: number): string {
  return `brain.vault.${accountId}`;
}

/** Only `brain.vault.<digits>` keys are vault paths. Task 8 may add other
 *  settings under this prefix; they must not be mistaken for vault paths. */
const VAULT_KEY_RE = /^brain\.vault\.\d+$/;

/**
 * accountId identifies which account's data is touched, so a malformed one is a
 * confidentiality risk, not a UX annoyance. It also has to agree with
 * vaultSettingKey's string coercion, or the same account can hold two handles
 * on one database file.
 */
function requireAccountId(accountId: number): number {
  if (!Number.isSafeInteger(accountId) || accountId < 1) {
    throw new Error(`invalid accountId: ${String(accountId)}`);
  }
  return accountId;
}

export interface VaultHandle {
  readonly accountId: number;
  readonly root: string;
  readonly vault: Vault;
  readonly index: VaultIndex;
  readonly git: VaultGit;
}

export interface BrainService {
  vaultPath(accountId: number): string | null;
  setVaultPath(accountId: number, path: string): void;
  clearVaultPath(accountId: number): void;
  /** Opens (and lazily creates) the account's vault. Null when unconfigured. */
  open(accountId: number): VaultHandle | null;
  search(accountId: number, query: string, opts?: SearchOptions): SearchHit[];
  writeNote(accountId: number, relPath: string, note: ParsedNote, commitMessage: string): void;
  closeAll(): void;
}

export function createBrainService(db: Database): BrainService {
  // One handle per account. Keyed by accountId, invalidated when its path moves.
  const handles = new Map<number, VaultHandle>();

  function readPath(accountId: number): string | null {
    return db.getSetting(vaultSettingKey(accountId));
  }

  function closeHandle(accountId: number): void {
    const existing = handles.get(accountId);
    if (existing) {
      existing.index.close();
      handles.delete(accountId);
    }
  }

  /**
   * Reject a vault path that IS, CONTAINS, or IS CONTAINED BY another account's
   * vault. Equality alone is insufficient: a nested vault means the outer
   * account's listNotes/readNote/rebuild see the inner account's notes, and the
   * outer vault's `git add -A` races the inner `git init`.
   */
  function assertNoOverlap(accountId: number, target: string): void {
    const rows = db.raw
      .prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'brain.vault.%'`)
      .all() as { key: string; value: string }[];
    for (const row of rows) {
      if (!VAULT_KEY_RE.test(row.key)) continue;
      if (row.key === vaultSettingKey(accountId)) continue;
      const other = canonicalPath(row.value);
      if (target === other || target.startsWith(other + sep) || other.startsWith(target + sep)) {
        throw new VaultConflictError(
          `vault path overlaps one already assigned to another account: ${target}`,
        );
      }
    }
  }

  const service: BrainService = {
    vaultPath(accountId: number): string | null {
      requireAccountId(accountId);
      return readPath(accountId);
    },

    setVaultPath(accountId: number, path: string): void {
      requireAccountId(accountId);
      const resolved = resolve(path);

      // Canonicalisation can only resolve symlinks and filesystem case for
      // segments that EXIST, and vault directories are otherwise created lazily
      // by open(). Materialise it first so the check below compares real
      // on-disk identity rather than two strings that merely look different.
      // mkdirSync returns the first directory it created, or undefined if
      // nothing was created — that is how we clean up on rejection.
      let created: string | undefined;
      try {
        created = mkdirSync(resolved, { recursive: true });
      } catch (err) {
        // A vault root the app cannot materialise is not a configurable vault.
        // Swallowing this would drop back to a lexical comparison, which is
        // exactly the alias bypass this check exists to stop.
        throw new Error(`cannot create vault directory: ${resolved} (${(err as Error).message})`);
      }

      try {
        assertNoOverlap(accountId, canonicalPath(resolved));
      } catch (err) {
        // Never leave a stray directory behind — least of all one whose name
        // the caller chose, inside another account's vault.
        if (created) rmSync(created, { recursive: true, force: true });
        throw err;
      }

      closeHandle(accountId);
      // Store the RESOLVED path, not the raw one: a stored relative path
      // re-resolves against whatever cwd happens to be current later, so two
      // configurations that looked distinct at config time can converge.
      // Deliberately NOT the canonical path — that rewrites /var/... to
      // /private/var/... and would surprise the user reading their settings.
      db.saveSetting(vaultSettingKey(accountId), resolved);
    },

    clearVaultPath(accountId: number): void {
      requireAccountId(accountId);
      closeHandle(accountId);
      db.raw.prepare('DELETE FROM app_settings WHERE key = ?').run(vaultSettingKey(accountId));
    },

    open(accountId: number): VaultHandle | null {
      requireAccountId(accountId);
      const path = readPath(accountId);
      // No configured vault is an ordinary state, not an error: indexing for
      // this account is simply inert.
      if (!path) return null;

      const cached = handles.get(accountId);
      if (cached?.root === resolve(path)) return cached;
      if (cached) closeHandle(accountId);

      const vault = createVault(path);
      vault.ensureLayout();

      // Re-validate at the point of use. The configuration-time check cannot
      // see a later on-disk change — e.g. this directory being replaced by a
      // symlink into another account's vault.
      assertNoOverlap(accountId, canonicalPath(vault.root));

      const git = createVaultGit(vault.root);
      // Versioning is a safety net; a missing git binary must not block a write.
      fireAndLogGitFailure(git.init(), 'brain: git init');

      const index = createVaultIndex(join(vault.root, '.omnifex', 'index.db'));

      const handle: VaultHandle = { accountId, root: vault.root, vault, index, git };
      handles.set(accountId, handle);
      return handle;
    },

    search(accountId: number, query: string, opts?: SearchOptions): SearchHit[] {
      requireAccountId(accountId);
      const handle = service.open(accountId);
      if (!handle) return [];
      return handle.index.search(query, opts);
    },

    writeNote(accountId: number, relPath: string, note: ParsedNote, commitMessage: string): void {
      requireAccountId(accountId);
      const handle = service.open(accountId);
      if (!handle) {
        // No silent fallback to another account's vault.
        throw new Error(`no vault configured for account ${accountId}`);
      }
      handle.vault.writeNote(relPath, note);
      handle.index.upsert(relPath, handle.vault.noteTitle(relPath), note);
      fireAndLogGitFailure(handle.git.commitAll(commitMessage), 'brain: commit');
    },

    closeAll(): void {
      for (const accountId of [...handles.keys()]) closeHandle(accountId);
    },
  };

  return service;
}
