import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '../database';
import { createVault, type Vault } from './vault';
import {
  createVaultIndex,
  readIndexedCount,
  type SearchHit,
  type SearchOptions,
  type VaultIndex,
} from './search';
import { createVaultGit, type VaultGit } from './git';
import { linkMatchesNote, parseWikilinks } from './links';
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

/** Git's own directory name inside a repository working tree. */
const GIT_DIR = '.git';

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

/** Today in the ISO date form the frontmatter schema requires. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface VaultHandle {
  readonly accountId: number;
  readonly root: string;
  readonly vault: Vault;
  readonly index: VaultIndex;
  readonly git: VaultGit;
}

/**
 * A vault's condition, answerable WITHOUT creating it.
 *
 * `open()` cannot serve this purpose: it lazily scaffolds the layout, which is
 * correct for first use and useless for a UI that has to tell "never
 * configured" apart from "configured, but the directory is gone". Every field
 * here is derived by looking, never by materialising.
 */
export interface VaultStatus {
  accountId: number;
  configured: boolean;
  /** The stored path, exactly as it was set. Null when unconfigured. */
  path: string | null;
  /** The directory exists on disk. */
  exists: boolean;
  /** The scaffolded layout is present (config/notes.json). */
  initialized: boolean;
  /** Markdown notes on disk. 0 when the vault does not exist. */
  noteCount: number;
  /** Rows in the FTS index, or null when there is no readable index. */
  indexedCount: number | null;
  gitAvailable: boolean;
  lastGitError: string | null;
  /** Why this vault cannot be opened, when it cannot be. */
  conflict: string | null;
}

export interface BrainService {
  vaultPath(accountId: number): string | null;
  setVaultPath(accountId: number, path: string): void;
  clearVaultPath(accountId: number): void;
  /** Opens (and lazily creates) the account's vault. Null when unconfigured. */
  open(accountId: number): VaultHandle | null;
  /** Describes the vault without creating it. Never throws for a broken one. */
  status(accountId: number): Promise<VaultStatus>;
  search(accountId: number, query: string, opts?: SearchOptions): SearchHit[];
  /** Note paths whose bodies wikilink to `relPath`. Empty when unconfigured. */
  backlinks(accountId: number, relPath: string): string[];
  writeNote(accountId: number, relPath: string, note: ParsedNote, commitMessage: string): void;
  /** Reindex the whole vault from disk. Returns the number of notes indexed. */
  rebuild(accountId: number): number;
  deleteNote(accountId: number, relPath: string): void;
  /** Replace a note's body, preserving its frontmatter. Returns the new note. */
  updateNoteBody(accountId: number, relPath: string, body: string): ParsedNote;
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
 * Refuse a `.git` that is anything other than this vault's own directory.
 *
 * Git resolves the repository from the working tree's `.git` entry, and that
 * entry has two redirecting forms. A SYMLINK points the object database at
 * another directory; a "gitfile" (a regular file containing `gitdir: <path>`)
 * does the same thing without a symlink. Under either, `commitAll` from this
 * vault appends this vault's note bodies into ANOTHER account's git history —
 * durable, cumulative, and invisible from either vault's directory listing,
 * because the working trees stay separate and only the history converges.
 *
 * Unlike the index database, `.git` is not created here. `git init` creates it
 * on a vault that has none, and the ordinary case is that it does not exist
 * yet — which is why absence is accepted rather than materialised.
 */
function assertOwnGitDir(root: string): void {
  const gitPath = join(root, GIT_DIR);
  const stat = lstatSync(gitPath, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isDirectory()) {
    throw new VaultConflictError(
      `vault .git is not its own directory (symlink or gitfile): ${gitPath}`,
    );
  }
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

  // Last real git failure per account, surfaced by status(). A vault whose
  // versioning is broken must be able to say so; see git.ts's CommitResult.
  const lastGitError = new Map<number, string>();

  function readPath(accountId: number): string | null {
    return db.getSetting(vaultSettingKey(accountId));
  }

  /**
   * Commit in the background and remember whether it worked.
   *
   * Fire-and-forget: the Markdown is already on disk and versioning is a safety
   * net, so a slow or failing commit must not block the write. But "must not
   * block" is not "must not be reported" — the previous shape discarded the
   * result entirely, so a persistently failing commit produced no log, no
   * error, and no visible signal anywhere.
   */
  function commitAndRecord(handle: VaultHandle, message: string): void {
    void handle.git
      .commitAll(message)
      .then((result) => {
        if (result.ok || result.reason === 'nothing-to-commit') {
          lastGitError.delete(handle.accountId);
          return;
        }
        lastGitError.set(handle.accountId, result.message);
        console.warn(`brain: commit failed for account ${handle.accountId}: ${result.message}`);
      })
      .catch((err: unknown) => {
        const message = (err as Error).message;
        lastGitError.set(handle.accountId, message);
        console.warn(`brain: commit threw for account ${handle.accountId}: ${message}`);
      });
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

  /** open() plus the "there must be a vault" contract every write path shares.
   *  Never falls back to another account's vault. */
  function requireHandle(accountId: number): VaultHandle {
    const handle = service.open(accountId);
    if (!handle) throw new Error(`no vault configured for account ${accountId}`);
    return handle;
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
        assertOwnGitDir(root);
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

    async status(accountId: number): Promise<VaultStatus> {
      requireAccountId(accountId);
      const stored = readPath(accountId);
      const base: VaultStatus = {
        accountId,
        configured: stored !== null,
        path: stored,
        exists: false,
        initialized: false,
        noteCount: 0,
        indexedCount: null,
        // Probed from the process cwd, not the vault root: the vault may not
        // exist, and "is git installed" is a property of the machine anyway.
        gitAvailable: await createVaultGit(process.cwd()).available(),
        lastGitError: lastGitError.get(accountId) ?? null,
        conflict: null,
      };
      if (stored === null) return base;

      // A stored value that open() would refuse is REPORTED rather than
      // thrown: this method exists to describe broken states, so failing on
      // one would leave the UI with nothing to render.
      let root: string;
      try {
        root = resolveVaultRoot(stored);
      } catch (err) {
        return { ...base, conflict: (err as Error).message };
      }

      try {
        assertNoOverlap(accountId, canonicalPath(root));
        assertOwnGitDir(root);
      } catch (err) {
        if (err instanceof VaultConflictError) return { ...base, conflict: err.message };
        throw err;
      }

      if (!existsSync(root)) return base;

      return {
        ...base,
        exists: true,
        initialized: existsSync(join(root, 'config', 'notes.json')),
        noteCount: createVault(root).listNotes().length,
        indexedCount: readIndexedCount(join(root, INDEX_DIR, INDEX_FILE)),
      };
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

    backlinks(accountId: number, relPath: string): string[] {
      requireAccountId(accountId);
      // A read path, so it degrades to empty rather than throwing — same rule
      // as search(). An unconfigured account simply has no backlinks.
      let handle: VaultHandle | null;
      try {
        handle = service.open(accountId);
      } catch (err) {
        if (err instanceof VaultConflictError) return [];
        throw err;
      }
      if (!handle) return [];

      // A full scan, deliberately: the FTS index is stemmed and limited, so
      // narrowing with it would silently miss links. A vault is hundreds of
      // local files and this runs only when a note is opened.
      const out: string[] = [];
      for (const candidate of handle.vault.listNotes()) {
        if (candidate === relPath) continue;
        let body: string;
        try {
          body = handle.vault.readNote(candidate).body;
        } catch {
          // A hand-edited note with broken frontmatter must not abort the scan.
          continue;
        }
        if (parseWikilinks(body).some((target) => linkMatchesNote(target, relPath))) {
          out.push(candidate);
        }
      }
      return out;
    },

    writeNote(accountId: number, relPath: string, note: ParsedNote, commitMessage: string): void {
      requireAccountId(accountId);
      const handle = requireHandle(accountId);
      handle.vault.writeNote(relPath, note);
      handle.index.upsert(relPath, handle.vault.noteTitle(relPath), note);
      commitAndRecord(handle, commitMessage);
    },

    rebuild(accountId: number): number {
      requireAccountId(accountId);
      const handle = requireHandle(accountId);
      return handle.index.rebuild(handle.vault);
    },

    deleteNote(accountId: number, relPath: string): void {
      requireAccountId(accountId);
      const handle = requireHandle(accountId);
      handle.vault.deleteNote(relPath);
      handle.index.remove(relPath);
      commitAndRecord(handle, `Delete ${handle.vault.noteTitle(relPath)}`);
    },

    updateNoteBody(accountId: number, relPath: string, body: string): ParsedNote {
      requireAccountId(accountId);
      const handle = requireHandle(accountId);
      // Read-modify-write rather than accepting a whole note from the caller.
      // The renderer edits prose; it has no business rewriting a note's type,
      // provenance or sources, and an edit box that could do so would make the
      // frontmatter untrustworthy for merge dedup later.
      const existing = handle.vault.readNote(relPath);
      const updated: ParsedNote = {
        frontmatter: { ...existing.frontmatter, updated: today() },
        body,
      };
      handle.vault.writeNote(relPath, updated);
      handle.index.upsert(relPath, handle.vault.noteTitle(relPath), updated);
      commitAndRecord(handle, 'Manual edit');
      return updated;
    },

    closeAll(): void {
      for (const accountId of [...handles.keys()]) closeHandle(accountId);
    },
  };

  return service;
}
