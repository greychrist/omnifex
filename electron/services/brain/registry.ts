import { join, resolve } from 'node:path';
import type { Database } from '../database';
import { createVault, type Vault } from './vault';
import { createVaultIndex, type SearchHit, type SearchOptions, type VaultIndex } from './search';
import { createVaultGit, type VaultGit } from './git';
import { fireAndLogGitFailure } from './git-logging';
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
      return readPath(accountId);
    },

    setVaultPath(accountId: number, path: string): void {
      const target = resolve(path);

      // Two accounts sharing a vault would defeat the whole isolation model, so
      // this is rejected at configuration time rather than guarded downstream.
      const rows = db.raw
        .prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'brain.vault.%'`)
        .all() as { key: string; value: string }[];
      for (const row of rows) {
        if (row.key === vaultSettingKey(accountId)) continue;
        if (resolve(row.value) === target) {
          throw new VaultConflictError(
            `vault path is already assigned to another account: ${target}`,
          );
        }
      }

      closeHandle(accountId);
      db.saveSetting(vaultSettingKey(accountId), path);
    },

    clearVaultPath(accountId: number): void {
      closeHandle(accountId);
      db.raw.prepare('DELETE FROM app_settings WHERE key = ?').run(vaultSettingKey(accountId));
    },

    open(accountId: number): VaultHandle | null {
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
      const handle = service.open(accountId);
      if (!handle) return [];
      return handle.index.search(query, opts);
    },

    writeNote(accountId: number, relPath: string, note: ParsedNote, commitMessage: string): void {
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
