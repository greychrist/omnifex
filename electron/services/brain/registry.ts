import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '../database';
import { createVault, type Vault } from './vault';
import { createVaultIndex, type SearchHit, type SearchOptions, type VaultIndex } from './search';
import { createVaultGit, type VaultGit } from './git';
import { fireAndLogGitFailure } from './git-logging';
import { canonicalPath, fsIdentity, isSameOrInside, resolveVaultRoot } from './paths';
import type { ParsedNote } from './types';

/**
 * Thrown when a vault's storage is not structurally isolated: its root overlaps
 * another account's vault, or its index database is not its own — either
 * resolving outside its root, or being literally the same file as another
 * account's index.
 */
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

/** The derived search index, inside the vault it indexes. Gitignored by the
 *  layout vault.ts scaffolds, and rebuildable from the Markdown. */
const INDEX_DIR = '.omnifex';
const INDEX_FILE = 'index.db';

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
 * A cached handle together with the on-disk identity of what it is bound to.
 * The identity is what makes the entry reusable: without it the cache is keyed
 * on a name, and a name can come to mean a different file or directory.
 */
interface CachedHandle {
  readonly handle: VaultHandle;
  /** Never null: an entry whose identity could not be read is not cached, so a
   *  missing object can never compare equal to another missing object. */
  readonly identity: string;
}

/**
 * The two on-disk objects a handle is bound to: the vault root its `Vault`
 * writes Markdown into, and the index database its `VaultIndex` holds open.
 * Null when either is missing — which is a cache miss, not a match, so a
 * deleted index rebuilds instead of being written to through a stale
 * descriptor pointing at an unlinked inode.
 */
function handleIdentity(root: string, indexFile: string): string | null {
  const rootId = fsIdentity(root);
  const indexId = fsIdentity(indexFile);
  return rootId === null || indexId === null ? null : `${rootId}|${indexId}`;
}

/**
 * Materialise the vault's index directory and return the index database path,
 * refusing an index that is not this vault's own.
 *
 * `vault.ts` routes every NOTE path through its own realpath discipline, but
 * the index is addressed here, by the registry, so nothing else guards it — and
 * the FTS5 table stores full note bodies (it is declared without `content=`),
 * so reaching another account's index is the confidentiality defect in full, in
 * both directions.
 *
 * The directory is judged, not a list of filenames. `index.db` is only one of
 * the files the connection owns: WAL mode gives it `index.db-wal` and
 * `index.db-shm`, and a hard-linked `-wal` leaks just as completely as a
 * hard-linked `index.db` — SQLite replays the shared WAL's frames over the
 * other database on open, so the victim's bodies appear AND the reader's own
 * notes disappear. Enumerating the directory is what makes this survive a
 * change of `journal_mode`, or a future SQLite sidecar nobody here has heard of.
 *
 * Two properties disqualify an entry:
 *
 *   - it is a SYMLINK. `mkdirSync` and better-sqlite3 both follow them, and a
 *     dangling one is worse than a live one: better-sqlite3 CREATES the target,
 *     inside the other vault. That is why the test is `lstat`-based rather than
 *     "resolve it and check where it lands" — a check that only fires when the
 *     target already exists is the round-1 failure again.
 *   - it is a file with more than one NAME (`nlink > 1`), i.e. a hard link. No
 *     path-based check can see one: both names are legitimately inside their
 *     own vault. `nlink` is O(1), needs no cross-account scan, and catches a
 *     link to anywhere rather than only to another configured account.
 *     Directories are exempt because '.' and '..' make `nlink > 1` normal for
 *     them; APFS/Time Machine clones use copy-on-write `clonefile`, which does
 *     not raise `nlink`, so ordinary backups do not trip this.
 *
 * The directory is CREATED here rather than tested for existence, for the same
 * reason as above — `createVaultIndex` would create it moments later anyway.
 * The index is derived, gitignored and rebuildable, so no entry under it has
 * any business being a link.
 */
function ensureVaultIndexPath(root: string): string {
  const dir = join(root, INDEX_DIR);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(`cannot create vault index directory: ${dir} (${(err as Error).message})`);
  }

  if (!isSameOrInside(realpathSync.native(dir), realpathSync.native(root))) {
    throw new VaultConflictError(`vault index directory resolves outside its vault: ${dir}`);
  }

  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    // Sidecars come and go with the connection, so an entry can vanish between
    // the readdir and the lstat. One that no longer exists cannot alias anything.
    const stat = lstatSync(abs, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      throw new VaultConflictError(`vault index entry is a symlink: ${abs}`);
    }
    if (stat.isFile() && stat.nlink > 1) {
      throw new VaultConflictError(`vault index entry is hard-linked: ${abs}`);
    }
  }

  return join(dir, INDEX_FILE);
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
   * Every OTHER account's configured vault row. Task 8 may add further settings
   * under this prefix, so the key shape is what decides, not the prefix.
   */
  function otherVaultRows(accountId: number): { key: string; value: string }[] {
    const rows = db.raw
      .prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'brain.vault.%'`)
      .all() as { key: string; value: string }[];
    return rows.filter((row) => VAULT_KEY_RE.test(row.key) && row.key !== vaultSettingKey(accountId));
  }

  /**
   * Reject a vault path that IS, CONTAINS, or IS CONTAINED BY another account's
   * vault. Equality alone is insufficient: a nested vault means the outer
   * account's listNotes/readNote/rebuild see the inner account's notes, and the
   * outer vault's `git add -A` races the inner `git init`.
   */
  function assertNoOverlap(accountId: number, target: string): void {
    for (const row of otherVaultRows(accountId)) {
      const other = canonicalPath(row.value);
      if (isSameOrInside(target, other) || isSameOrInside(other, target)) {
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

      // Route the stored value through the SAME validation setVaultPath()
      // applies, here at the point it is READ FROM STORAGE — not only where it
      // was written. app_settings can be written directly (tests do it, and a
      // dev-only raw-SQL channel exists), so a stored value never actually
      // passed through setVaultPath() at all. A bare `resolve()` would accept
      // whitespace-only or `~`-prefixed garbage and happily scaffold a vault at
      // e.g. `<cwd>/   `. An invalid stored value is treated the same as "no
      // configured vault" (return null) rather than thrown: this keeps the
      // unconfigured-account contract uniform for every caller of open(),
      // including search(), which already returns [] for that case.
      let root: string;
      try {
        root = resolveVaultRoot(path);
      } catch {
        return null;
      }

      // THE GUARD. Unconditional, and first: before the cache is consulted and
      // before a single byte is written to disk.
      //
      // Before the cache, because a check that only runs on a cold open stops
      // being a check the moment a handle exists — the process then reuses that
      // handle for its whole life. Before ensureLayout(), because scaffolding a
      // vault into the directory and only then deciding it belongs to another
      // account means the victim's vault has already been written into.
      //
      // Two storage locations have to be judged, not one: the vault ROOT, which
      // holds the Markdown, and the index DATABASE, which holds a full copy of
      // every note body in its FTS table. Guarding only the root leaves the
      // index reachable through its own aliases.
      let indexFile: string;
      try {
        assertNoOverlap(accountId, canonicalPath(root));
        indexFile = ensureVaultIndexPath(root);
      } catch (err) {
        // Fail closed and let go: a handle just judged unsafe must not keep a
        // live SQLite descriptor open on another account's vault.
        closeHandle(accountId);
        throw err;
      }

      // Reuse the handle only when the configured name AND the objects that
      // name currently reaches are the ones it was built for.
      // (A null current identity can never match: cached.identity is a string.)
      const cached = handles.get(accountId);
      if (cached?.identity === handleIdentity(root, indexFile) && cached.handle.root === root) {
        return cached.handle;
      }
      if (cached) closeHandle(accountId);

      const vault = createVault(root);
      vault.ensureLayout();

      const git = createVaultGit(vault.root);
      // Versioning is a safety net; a missing git binary must not block a write.
      fireAndLogGitFailure(git.init(), 'brain: git init');

      const index = createVaultIndex(indexFile);

      const handle: VaultHandle = { accountId, root: vault.root, vault, index, git };
      // Read the identity again, after the index file has been created: on a
      // cold open it did not exist a moment ago, so the earlier read was null.
      // If it still cannot be read, do not cache — an unidentifiable handle
      // would be indistinguishable from the next unidentifiable one.
      const identity = handleIdentity(vault.root, indexFile);
      if (identity !== null) handles.set(accountId, { handle, identity });
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
