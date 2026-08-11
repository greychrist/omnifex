import { mkdirSync } from 'node:fs';
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

  const service: BrainService = {
    vaultPath(accountId: number): string | null {
      requireAccountId(accountId);
      return readPath(accountId);
    },

    setVaultPath(accountId: number, path: string): void {
      requireAccountId(accountId);
      // Canonicalisation can only resolve symlinks and filesystem case for
      // segments that EXIST. Vault directories are created lazily by open(), so
      // at this point the path normally does not exist and canonicalPath()
      // degrades to a lexical resolve — the exact alias bypass this check
      // exists to stop. Create it first; open() would create it moments later
      // anyway, so this brings no new side effect.
      try {
        mkdirSync(resolve(path), { recursive: true });
      } catch {
        // Unwritable or otherwise uncreatable: fall through. canonicalPath
        // still does what it can, and open() surfaces the real error.
      }
      const target = canonicalPath(path);

      // Two accounts sharing a vault would defeat the whole isolation model, so
      // this is rejected at configuration time rather than guarded downstream.
      const rows = db.raw
        .prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'brain.vault.%'`)
        .all() as { key: string; value: string }[];
      for (const row of rows) {
        if (!VAULT_KEY_RE.test(row.key)) continue;
        if (row.key === vaultSettingKey(accountId)) continue;
        const other = canonicalPath(row.value);
        // Equality is not enough: one vault nested inside another means the
        // outer account's listNotes/readNote/rebuild see the inner account's
        // notes, and the outer vault's `git add -A` races the inner `git init`.
        if (target === other || target.startsWith(other + sep) || other.startsWith(target + sep)) {
          throw new VaultConflictError(
            `vault path overlaps one already assigned to another account: ${target}`,
          );
        }
      }

      closeHandle(accountId);
      db.saveSetting(vaultSettingKey(accountId), path);
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
