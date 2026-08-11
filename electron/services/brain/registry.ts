import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Database } from '../database';
import { createVault, type Vault } from './vault';
import { createVaultIndex, type SearchHit, type SearchOptions, type VaultIndex } from './search';
import { createVaultGit, type VaultGit } from './git';
import { fireAndLogGitFailure } from './git-logging';
import { canonicalPath, directoryIdentity, resolveVaultRoot } from './paths';
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

/**
 * A cached handle together with the on-disk identity of the directory it was
 * built against. The identity is what makes the entry reusable: without it the
 * cache is keyed on a name, and a name can come to mean a different directory.
 */
interface CachedHandle {
  readonly handle: VaultHandle;
  readonly identity: string | null;
}

/**
 * Per-account vault registry.
 *
 * The isolation guarantee rests on one structural rule: `open()` is the ONLY
 * place a VaultHandle is produced, and no handle leaves it without a fresh
 * overlap check against the live filesystem and the live settings table. The
 * handle cache is a memo, not an authority — it may skip CONSTRUCTION, never
 * VALIDATION. Every previous shape of this file made the guard conditional on
 * something (the directory already existing, mkdir succeeding, the handle being
 * cold), and every one of those conditions turned out to be reachable.
 */
export function createBrainService(db: Database): BrainService {
  // One handle per account. Keyed by accountId, invalidated when its path moves
  // or when the directory that path names is no longer the same directory.
  const handles = new Map<number, CachedHandle>();

  function readPath(accountId: number): string | null {
    return db.getSetting(vaultSettingKey(accountId));
  }

  function closeHandle(accountId: number): void {
    const existing = handles.get(accountId);
    if (existing) {
      existing.handle.index.close();
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
      // Judge the string before it can have any filesystem effect: the
      // materialisation below writes to whatever it is handed, so `''` (the
      // process cwd) and `~/…` (a directory literally named `~`) have to be
      // refused here, not discovered afterwards.
      const resolved = resolveVaultRoot(path);

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
      const root = resolve(path);

      // THE GUARD. Unconditional, and first: before the cache is consulted and
      // before a single byte is written to disk.
      //
      // Before the cache, because a check that only runs on a cold open stops
      // being a check the moment a handle exists — the process then reuses that
      // handle for its whole life. Before ensureLayout(), because scaffolding a
      // vault into the directory and only then deciding it belongs to another
      // account means the victim's vault has already been written into.
      try {
        assertNoOverlap(accountId, canonicalPath(root));
      } catch (err) {
        // Fail closed and let go: a handle just judged unsafe must not keep a
        // live SQLite descriptor open on another account's vault.
        closeHandle(accountId);
        throw err;
      }

      // Reuse the handle only when the configured name AND the directory that
      // name currently reaches are both the ones it was built for. A null
      // identity means the root is gone, which is a miss, not a match.
      const cached = handles.get(accountId);
      const identity = directoryIdentity(root);
      if (cached && identity !== null && cached.identity === identity && cached.handle.root === root) {
        return cached.handle;
      }
      if (cached) closeHandle(accountId);

      const vault = createVault(root);
      vault.ensureLayout();

      const git = createVaultGit(vault.root);
      // Versioning is a safety net; a missing git binary must not block a write.
      fireAndLogGitFailure(git.init(), 'brain: git init');

      const index = createVaultIndex(join(vault.root, '.omnifex', 'index.db'));

      const handle: VaultHandle = { accountId, root: vault.root, vault, index, git };
      // Read the identity again, after ensureLayout: on a cold open the
      // directory did not exist a moment ago, so the earlier read was null.
      handles.set(accountId, { handle, identity: directoryIdentity(vault.root) });
      return handle;
    },

    search(accountId: number, query: string, opts?: SearchOptions): SearchHit[] {
      requireAccountId(accountId);
      let handle: VaultHandle | null;
      try {
        handle = service.open(accountId);
      } catch (err) {
        // The overlap test is necessarily symmetric — it cannot tell the victim
        // of an aliasing swap from its cause — so a bad symlink under one
        // account would otherwise start throwing at the OTHER account, whose
        // configuration and directory never changed. The Brain is auxiliary, so
        // a read degrades to empty instead. Everything that hands out a handle
        // or writes (open, writeNote) still fails closed, so this costs
        // visibility, never confidentiality.
        if (err instanceof VaultConflictError) {
          console.warn(`brain: search disabled for account ${accountId}: ${err.message}`);
          return [];
        }
        throw err;
      }
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
