import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Database } from '../database';
import { createVault, type Vault } from './vault';
import {
  createVaultIndex,
  readIndexedCount,
  type SearchHit,
  type SearchOptions,
  type VaultIndex,
} from './search';
import { createVaultGit, type ExecGit, type VaultGit } from './git';
import { linkMatchesNote, parseWikilinks } from './links';
import { fireAndLogGitFailure } from './git-logging';
import { canonicalPath, fsIdentity, isSameOrInside, resolveVaultRoot } from './paths';
import { createSourceStateStore, type SourceStatus } from './sources/state';
import {
  CURATION_SOURCE_ID,
  createBrainQueueStore,
  createBrainQueueWorker,
  isRateLimitError,
  type DrainOutcome,
  type QueueCounts,
  type QueueEntry,
} from './queue';
import type { BrainSource, ItemMetadata, SourceItem } from './sources/types';
import { SESSION_SOURCE_ID } from './sources/session-transcripts';
import { EXTRACTION_MODEL, type Extractor } from './extract';
import { CURATION_MODEL } from './curation';
import { createBrainSpendStore, localDate, type SpendKind } from './spend';
import type { RunCost } from './sources/state';
import { resolveEntityPath, type ExistingNote } from './resolve';
import { merge } from './merge';
import { MAX_NOTES_PER_RUN, collapsibleEntries, curate, qualifies } from './curate';
import type { Curator } from './curation';
import { computeVaultStats, type VaultStats } from './stats';
import { isExcludedProject, parseDecisions, type ProjectDecisions } from './exclusions';
import type { AccountsService } from '../accounts';
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

/**
 * app_settings key holding one account's project include/exclude decisions.
 *
 * A settings key rather than a table: this is a handful of strings per
 * account, and it matches how the vault path is already stored. The value is
 * a JSON map of absolute project path → excluded, and an ABSENT entry is not
 * "included" — it means no decision has been recorded, so the default rule in
 * `exclusions.ts` applies. That distinction is what lets scratch projects be
 * excluded out of the box while staying re-includable.
 */
export function excludedProjectsKey(accountId: number): string {
  return `brain.excludedProjects.${String(accountId)}`;
}

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

/** The date a distilled item should stamp on the notes it produces. */
function provenanceDate(metadata: ItemMetadata): string {
  switch (metadata.kind) {
    case 'capture':
      return metadata.capturedAt.slice(0, 10) || today();
    case 'session':
      return metadata.startedAt?.slice(0, 10) ?? today();
    case 'artifact':
      return today();
  }
}

export interface VaultHandle {
  readonly accountId: number;
  readonly root: string;
  readonly vault: Vault;
  readonly index: VaultIndex;
  readonly git: VaultGit;
  /**
   * Resolves when this handle's `git init` has settled — successfully or not.
   *
   * `open()` cannot await it: opening a vault stays synchronous, and
   * versioning is auxiliary anyway. But an untracked child process still
   * writing into `.git` is observable to anyone who deletes the vault
   * directory afterwards — test cleanup hit exactly this, as ENOTEMPTY under
   * full-suite load. Retaining the promise makes the init joinable by whoever
   * needs it to be, without making anyone wait who does not.
   *
   * Never rejects: a rejection here would surface as an unhandled rejection in
   * every call site that stores a handle without awaiting.
   */
  readonly gitReady: Promise<void>;
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

/** One discovered item, with the gate's verdict and its recorded state. */
export interface SourceSummary {
  accountId: number;
  sourceId: string;
  itemKey: string;
  /**
   * What to call this row: a session's id, or a file-backed item's file name.
   *
   * Computed here rather than in the renderer because the rule is per source
   * kind, and the adapters own kind. Never a full path — the project column
   * already carries the folder, and repeating it in every row buried the one
   * part that identifies the item.
   */
  name: string;
  /**
   * True when this row is a session that is open in OmniFex right now. Such a
   * transcript is still being written, so indexing it would distil half a
   * conversation and record it as done.
   */
  inUse: boolean;
  /** The project folder, absolute. Grouping and exclusion key. */
  label: string;
  mtimeMs: number;
  /** Bytes on disk. Without it a 21MB session looks like a 40KB one, and size
   *  is the best single predictor of what indexing it will cost. */
  size: number;
  admitted: boolean;
  reason: string;
  /** Recorded state, or null when this item has never been through indexing. */
  status: SourceStatus | null;
  changed: boolean;
  /** True when this item's project is on the account's exclusion list. Only
   *  ever true when the caller asked to see excluded rows. */
  excluded: boolean;
  /**
   * What the last model-backed run on this item cost, as the CLI reported it.
   * Null means nothing has ever been spent here — not that a run was free.
   */
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

/** What one indexing run did. */
export interface IndexResult {
  itemKey: string;
  /** Vault-relative paths written, in the order they were written. */
  notesWritten: string[];
  /** True when nothing was indexed — gate rejection or a recorded failure. */
  skipped: boolean;
  reason: string;
}

/**
 * An indexing run in flight, as any window can read it back.
 *
 * This lives in the main process on purpose. It used to be React state inside
 * BrainSources.tsx, so it died with the component — and the pane unmounts
 * whenever the Brain tab's sub-tab changes, leaving a run that was still
 * spending tokens with nothing on screen to say so.
 *
 * Note it is NOT persisted. It does not need to be: `indexSource` records
 * every item's outcome through `sourceState` before it returns, so an app quit
 * mid-run loses this summary and nothing else — the next listing reads the
 * truth off the rows themselves.
 */
export interface BrainRun {
  /** The account whose vault this run is writing into. */
  accountId: number;
  /** Items the run was asked to do. */
  total: number;
  /** Items taken to a terminal state so far — finished, NOT started. */
  completed: number;
  /** The item being worked on right now: the `completed + 1`-th. */
  item: string;
  /** Items that produced at least one note. */
  written: number;
  /** Items that were skipped or failed. Both are completed units of work. */
  skipped: number;
}

/** What a whole selection cost, once every item reached a terminal state. */
export interface RunResult {
  /** Items that produced at least one note. */
  written: number;
  /** Items skipped or failed. Both are completed units of work. */
  skipped: number;
  /**
   * One entry per item, in the order given — including items that threw, which
   * are recorded as skips carrying the thrown message as their reason.
   *
   * Kept per-item rather than collapsed to counts because a one-item run has
   * to be able to say WHY: "Not indexed: session is still open in OmniFex" is
   * the whole answer, and "indexed 0, skipped 1" is none of it.
   *
   * Note this reports only per-ITEM outcomes. Something that stops the whole
   * run — no vault, a run already in flight — rejects the call instead, so the
   * pane can tell "nothing ran" apart from "it ran and declined".
   */
  results: IndexResult[];
}

/** What one curation run did to one note. */
export interface CurateResult {
  notePath: string;
  /** True when nothing was spent: the note vanished, or stopped qualifying. */
  skipped: boolean;
  reason: string;
}

/**
 * The view of one item, for inspection before any token is spent.
 *
 * `metadata` is null for a translating source: there is no distillation behind
 * it and therefore no distillation metadata. What it produces is the preview,
 * so `notePaths` names the notes it would write and `prose` carries their
 * bodies. Reporting a fabricated metadata shape instead would be the same
 * mistake the ItemMetadata discriminant exists to prevent.
 */
export interface SourcePreview {
  itemKey: string;
  prose: string;
  metadata: ItemMetadata | null;
  /** Notes a translating source would write. Empty for a distilled item. */
  notePaths: string[];
  truncated: boolean;
  admitted: boolean;
  reason: string;
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
  /**
   * Discovered items for ONE account, with each item's gate verdict and
   * whether it has changed since it was last recorded.
   *
   * Filtering happens after discovery rather than by asking adapters for one
   * account's items: ownership is derived from where an item lives, so an
   * adapter that accepted an accountId would be letting the caller assert
   * ownership instead. Discovery is a directory walk, not a model call —
   * doing it whole and filtering after costs nothing worth protecting.
   */
  listSources(accountId: number, opts?: { includeExcluded?: boolean }): Promise<SourceSummary[]>;
  /**
   * Record which project folders this account may index.
   *
   * A complete map of the decisions being made, not a list of exclusions: an
   * absent key means "no decision", which leaves the scratch-path default in
   * force, so sending only the excluded paths would silently re-exclude every
   * temp project the user had deliberately re-included.
   *
   * Excluded projects drop out of discovery entirely — they never list, never
   * enqueue, and never index on session close, which is the only thing that
   * keeps a temp project out of the vault while Auto-index is on.
   */
  setExcludedProjects(accountId: number, decisions: ProjectDecisions): void;
  /** Distilled preview of one item, or null when it is not this account's. */
  previewSource(accountId: number, itemKey: string): Promise<SourcePreview | null>;
  /**
   * Extract one item and merge the result into this account's vault.
   *
   * The only method here that spends tokens. It resolves rather than rejecting
   * for a gate rejection or a failed extraction — both are recorded outcomes,
   * and the Brain is auxiliary — but it throws for the caller's own mistakes:
   * an unknown item, an unconfigured vault, or a service built without an
   * extractor.
   */
  indexSource(
    accountId: number,
    itemKey: string,
    opts?: { force?: boolean },
  ): Promise<IndexResult>;
  /**
   * Index a whole selection, one item at a time, tracking progress that
   * outlives any window.
   *
   * Deliberately a sequential loop over exactly `itemKeys` rather than a queue
   * drain: draining processes everything pending, which is how "Drain now"
   * once ran 158 sessions when the user had ticked one. Nothing here can reach
   * an item the caller did not name.
   *
   * Concurrency 1, like the queue worker, for the same reason — the rate limit
   * is shared, and two runs would pay twice for an item in both selections. A
   * second call while one is in flight throws.
   *
   * Per-item failures are collected, never thrown: one bad item must not
   * abandon the rest of a selection the user explicitly ticked.
   */
  indexSelection(accountId: number, itemKeys: string[]): Promise<RunResult>;
  /**
   * The run in flight for this account, or null. Account-scoped so a run
   * cannot be reported under another account's header.
   *
   * A fresh mount calls this to rebuild its progress banner, the same way
   * SessionList calls `summary_generating_now` for work that started before it
   * could subscribe.
   */
  currentRun(accountId: number): BrainRun | null;
  /**
   * The run in flight for ANY account, for the app-wide indicator. Carries its
   * own `accountId` so the caller can name the vault rather than guess it.
   */
  activeRun(): BrainRun | null;
  /**
   * Compress one note's accumulated Timeline. The second method here that
   * spends tokens.
   *
   * Re-checks `qualifies` BEFORE spending: a note can change between enqueue
   * and claim, and Plan 4a's most expensive bug was `indexSource` ignoring
   * exactly this class of check while every unit test passed.
   *
   * Resolves with `skipped` for a note that vanished or stopped qualifying —
   * both are completed units of work. Rejects when the model reply is
   * unusable, so the queue records a failure and the note is left untouched.
   */
  curateNote(accountId: number, relPath: string): Promise<CurateResult>;
  /**
   * Queue the notes most worth compressing, longest Timeline first, capped at
   * `MAX_NOTES_PER_RUN`. Returns how many were queued.
   *
   * Synchronous, unlike `backfill`: reading a vault is, and `discover()` is
   * what makes that one async.
   */
  enqueueCuration(accountId: number): number;
  /** Queue one item this account owns. Throws for an item it does not. */
  enqueueSource(accountId: number, itemKey: string): Promise<void>;
  /**
   * Queue every NON-session item this account owns that belongs to
   * `projectPath` — its auto-memory notes and its repo instruction files.
   * Returns how many were queued.
   *
   * Matched on each item's own key rather than on keys reconstructed by the
   * caller: the key formats belong to the adapters, and a second spelling in
   * `main.ts` would go quietly stale the moment one changed.
   */
  enqueueProjectSources(accountId: number, projectPath: string): Promise<number>;
  /**
   * Queue every admitted item this account owns that is not already indexed
   * and unchanged. Returns how many were queued.
   */
  backfill(accountId: number): Promise<number>;
  /**
   * Vault size, context cost and Timeline distribution. Zeroes when
   * unconfigured — a stats panel must render rather than throw.
   */
  stats(accountId: number): VaultStats;
  queueCounts(accountId?: number): QueueCounts;
  queueList(accountId: number, limit?: number): QueueEntry[];
  clearFinishedQueue(accountId: number): void;
  /**
   * Drain the queue, yielding to interactive sessions. Never throws.
   *
   * Returns what it actually did, so a caller can tell "indexed 158" from
   * "yielded instantly because a session was open" — the Brain tab reported
   * both as success until this returned something.
   */
  drainQueue(): Promise<DrainOutcome>;
  /** The entry being indexed right now, for the operational pane. */
  queueCurrent(): QueueEntry | null;
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
 * Titles and aliases of every note currently in a vault.
 *
 * A note that cannot be parsed is skipped rather than failing the read: the
 * spec's error table isolates a broken note to that note, and a single
 * hand-mangled file must not stop the whole vault from being resolvable.
 */
function readExistingNotes(handle: VaultHandle): ExistingNote[] {
  const out: ExistingNote[] = [];
  for (const path of handle.vault.listNotes()) {
    try {
      const note = handle.vault.readNote(path);
      out.push({
        path,
        title: handle.vault.noteTitle(path),
        aliases: note.frontmatter.aliases,
      });
    } catch {
      // Unparseable frontmatter — surfaced elsewhere, ignored here.
    }
  }
  return out;
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
export interface BrainServiceOptions {
  /**
   * Git runner for every vault this service opens. Production passes nothing
   * and gets the real `git` binary. Tests pass a stub so no child process is
   * spawned — which is what makes vault cleanup deterministic rather than a
   * race against an untracked `git init`.
   */
  execGit?: ExecGit;
  /**
   * Source adapters this service can enumerate. Injected rather than
   * constructed here so the registry stays free of any knowledge of where
   * transcripts live — and so tests can supply a fake source without needing
   * a config dir on disk.
   */
  sources?: BrainSource[];
  /**
   * Account lookup, needed only by `indexSource`: an item's owning account
   * supplies the `CLAUDE_CONFIG_DIR` its extraction runs under (spec §8).
   * Optional so every existing construction site keeps working, but
   * `indexSource` fails loudly without it rather than becoming a silent no-op.
   */
  accounts?: AccountsService;
  /** Turns distilled prose into entities. Absent means indexing is unavailable. */
  extractor?: Extractor;
  /**
   * Compresses an accumulated note. Absent means curation is unavailable —
   * `curateNote` throws rather than silently no-opping, the same rule
   * `extractor` follows.
   */
  curator?: Curator;
  /** True while the user has paused the queue from the Brain tab. */
  isQueuePaused?: () => boolean;
  /**
   * Session UUIDs open in OmniFex right now — `SessionsService`'s
   * `listActiveSessionIds()`, injected so the Brain keeps no dependency on the
   * sessions layer.
   *
   * Since Plan 8 removed the global "is the user working?" gate, this is the
   * ONLY session-awareness the indexer has, and the only one it needed: WHICH
   * transcripts are still being written, and therefore must not be distilled
   * and recorded as finished.
   *
   * Defaults to "nothing is open", correct for tests and for any construction
   * without a sessions dependency.
   */
  liveSessionIds?: () => Iterable<string>;
  /**
   * Called on every change to the run in flight, and once with `null` when it
   * ends. `main.ts` forwards this to the renderer; tests record the sequence.
   *
   * The terminating `null` is load-bearing: without it a live pane would hang
   * on the last frame forever, showing a bar for a run that had finished.
   */
  onRunProgress?: (run: BrainRun | null) => void;
}

export function createBrainService(
  db: Database,
  opts: BrainServiceOptions = {},
): BrainService {
  // One handle per account. Keyed by accountId, invalidated when its path moves
  // or when the directory that path names is no longer the same directory.
  const handles = new Map<number, CachedHandle>();

  // Last real git failure per account, surfaced by status(). A vault whose
  // versioning is broken must be able to say so; see git.ts's CommitResult.
  const lastGitError = new Map<number, string>();

  // Source adapters and their bookkeeping. Empty by default: a service with no
  // sources answers "nothing discovered", which is the correct answer for a
  // caller that never wired any up.
  const sources = opts.sources ?? [];
  const sourceState = createSourceStateStore(db);
  const queueStore = createBrainQueueStore(db);
  const spendStore = createBrainSpendStore(db);

  /**
   * Append one model-backed run to the ledger.
   *
   * Swallows its own failure on purpose: losing an accounting row must never
   * lose the note the money already bought, and this runs after the write that
   * matters. The `run` guard is what keeps a gate rejection or a translating
   * source — neither of which reaches a model — from inventing a payment.
   */
  function recordSpend(
    accountId: number,
    kind: SpendKind,
    sourceId: string | null,
    itemKey: string,
    model: string,
    run: RunCost | undefined,
  ): void {
    if (!run) return;
    try {
      const at = new Date();
      spendStore.record({
        ...run,
        accountId,
        accountName:
          opts.accounts?.listAccounts().find((a) => a.id === accountId)?.name ??
          `account ${String(accountId)}`,
        kind,
        sourceId,
        itemKey,
        model,
        date: localDate(at),
        spentAt: at.toISOString(),
      });
    } catch (err) {
      console.warn('[brain] spend ledger write failed:', (err as Error).message);
    }
  }

  // The run in flight, or null. One at a time across all accounts, matching
  // the queue worker's concurrency-1 contract with the shared rate limit.
  let activeRun: BrainRun | null = null;

  /**
   * Push the current run to whoever is listening.
   *
   * Wrapped so a throwing subscriber cannot take the run down with it: the
   * subscriber is `webContents.send` on a window that may have closed
   * mid-run, and losing the display must never abort work already paid for.
   */
  function publishRun(): void {
    if (!opts.onRunProgress) return;
    try {
      opts.onRunProgress(activeRun);
    } catch (err) {
      console.warn('[brain] run progress subscriber threw:', (err as Error).message);
    }
  }

  // A crash or quit mid-item leaves a row `running` forever; without this the
  // queue silently stops draining after one bad shutdown.
  const orphans = queueStore.recoverOrphans();
  if (orphans > 0) console.warn(`brain: recovered ${String(orphans)} orphaned queue entries`);

  /**
   * Progress counters for the drain in flight, reset per drain.
   *
   * Before Plan 8 only `indexSelection` published a `BrainRun`, so background
   * indexing — the kind that actually runs unattended — was the one kind with
   * nothing on screen to say it was happening.
   */
  let queueRunStats = { completed: 0, written: 0, skipped: 0 };

  const queueWorker = createBrainQueueWorker({
    store: queueStore,
    // The dispatch. Routed through the service's own methods rather than
    // captured closures, so every drain gets the unchanged-item short-circuit,
    // the per-entity isolation and the re-qualification check that live there.
    process: async (entry) => {
      // `total` is recomputed per entry rather than snapshotted at drain start,
      // so an enqueue that lands mid-drain widens the bar instead of pushing it
      // past 100%. The claimed entry is no longer `pending`, hence the +1.
      activeRun = {
        accountId: entry.accountId,
        total: queueRunStats.completed + 1 + queueStore.counts().pending,
        completed: queueRunStats.completed,
        item: entry.itemKey,
        written: queueRunStats.written,
        skipped: queueRunStats.skipped,
      };
      publishRun();

      try {
        const result =
          entry.sourceId === CURATION_SOURCE_ID
            ? await service.curateNote(entry.accountId, entry.itemKey)
            : await service.indexSource(entry.accountId, entry.itemKey);
        if (result.skipped) queueRunStats.skipped += 1;
        else queueRunStats.written += 1;
      } catch (err) {
        // A rate limit puts the item back on the queue untouched, so counting
        // it as completed would report work the user never got.
        if (!isRateLimitError((err as Error).message)) queueRunStats.skipped += 1;
        else queueRunStats.completed -= 1;
        throw err;
      } finally {
        queueRunStats.completed += 1;
      }
    },
    isPaused: opts.isQueuePaused ?? (() => false),
  });

  /**
   * Locate one item by account AND key.
   *
   * Both, never the key alone: a session id is unique per account, not
   * globally, so matching on the key would hand one account's transcript to
   * whoever guessed the id.
   */
  async function findItem(
    accountId: number,
    itemKey: string,
  ): Promise<{ source: BrainSource; item: SourceItem } | null> {
    for (const source of sources) {
      const items = await source.discover();
      const item = items.find((i) => i.itemKey === itemKey && i.accountId === accountId);
      if (item) return { source, item };
    }
    return null;
  }

  /**
   * The set of session UUIDs open right now, or empty when the lookup fails.
   *
   * Swallows a throwing provider on purpose: this feeds a listing that must
   * render, and the enforcement that actually protects money lives in
   * `indexSource`. A pane that dies because the sessions service hiccupped
   * would be a worse failure than a badge that is briefly missing.
   */
  function liveSessions(): Set<string> {
    try {
      return new Set(opts.liveSessionIds?.() ?? []);
    } catch {
      return new Set();
    }
  }

  /** True when this item is a session transcript that is still being written. */
  function isLiveItem(item: SourceItem, live: Set<string> = liveSessions()): boolean {
    return item.sourceId === SESSION_SOURCE_ID && live.has(item.itemKey);
  }

  /**
   * The row's display name. A session is named by its id — that is the thing
   * you paste to find one conversation. Everything else is a file, and its
   * file name says more than an encoded key does. Falls back to the key for a
   * source with no real path behind it.
   */
  function displayName(item: SourceItem): string {
    if (item.sourceId === SESSION_SOURCE_ID) return item.itemKey;
    const base = item.path ? basename(item.path) : '';
    return base || item.itemKey;
  }

  /**
   * What this account has spent on the Brain, from the ledger.
   *
   * Read from `brain_spend`, not `brain_sources`. The per-item column is a
   * snapshot the next re-index overwrites, so summing it reported only the most
   * recent run of each item and understated every vault that had been indexed
   * twice. It also cannot see curation, which writes no `brain_sources` row at
   * all.
   *
   * Scoped by account_id like every other read here: one account's spend must
   * never be reported under another's header, which is the same rule that
   * governs the notes themselves.
   */
  function spentUsd(accountId: number): number {
    return spendStore.total(accountId);
  }

  function readPath(accountId: number): string | null {
    return db.getSetting(vaultSettingKey(accountId));
  }

  /** One account's recorded project decisions. */
  function readDecisions(accountId: number): ProjectDecisions {
    return parseDecisions(db.getSetting(excludedProjectsKey(accountId)));
  }

  /**
   * The single exclusion predicate, applied at EVERY path that can reach the
   * model. Discovery alone is not enough: the queue is durable across restarts,
   * so an exclusion added today has to stop work queued yesterday.
   */
  function isExcludedItem(accountId: number, item: SourceItem): boolean {
    return isExcludedProject(item.label, readDecisions(accountId));
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

      const git = createVaultGit(vault.root, opts.execGit);
      // Versioning is a safety net; a missing git binary must not block a
      // write. The promise is RETAINED rather than dropped, so callers that
      // must not race the init — test cleanup, and any future indexer that
      // commits immediately after opening — can join it.
      const gitReady = git.init().catch((err: unknown) => {
        console.warn('brain: git init failed:', err);
      });

      const index = createVaultIndex(indexFile);

      const handle: VaultHandle = { accountId, root: vault.root, vault, index, git, gitReady };
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

    setExcludedProjects(accountId: number, decisions: ProjectDecisions): void {
      requireAccountId(accountId);
      // Key-sorted so the stored value is stable: an unordered map would
      // rewrite the setting on every save and make diffs meaningless.
      const stable: ProjectDecisions = {};
      for (const key of Object.keys(decisions).sort()) {
        if (key !== '') stable[key] = decisions[key];
      }
      db.saveSetting(excludedProjectsKey(accountId), JSON.stringify(stable));
    },

    async listSources(
      accountId: number,
      opts: { includeExcluded?: boolean } = {},
    ): Promise<SourceSummary[]> {
      requireAccountId(accountId);
      const decisions = readDecisions(accountId);
      // Read once for the whole listing rather than per row: the set is a
      // snapshot either way, and a per-row read could mark two rows of the
      // same scan against different states of the world.
      const live = liveSessions();
      const summaries: SourceSummary[] = [];
      for (const source of sources) {
        for (const item of await source.discover()) {
          // The filter that makes this account-scoped. An item belonging to
          // another account is not merely uninteresting here — surfacing it
          // would put one account's project names in another's UI.
          if (item.accountId !== accountId) continue;
          const isExcluded = isExcludedProject(item.label, decisions);
          if (isExcluded && opts.includeExcluded !== true) continue;
          const verdict = source.admit(item);
          const prior = sourceState.get(accountId, item.sourceId, item.itemKey);
          summaries.push({
            accountId,
            sourceId: item.sourceId,
            itemKey: item.itemKey,
            name: displayName(item),
            inUse: isLiveItem(item, live),
            label: item.label,
            mtimeMs: item.mtimeMs,
            size: item.size,
            admitted: verdict.admitted,
            reason: verdict.reason,
            status: prior?.status ?? null,
            changed: sourceState.hasChanged(item),
            excluded: isExcluded,
            costUsd: prior?.cost?.costUsd ?? null,
            inputTokens: prior?.cost?.inputTokens ?? null,
            outputTokens: prior?.cost?.outputTokens ?? null,
            cacheReadTokens: prior?.cost?.cacheReadTokens ?? null,
            cacheCreationTokens: prior?.cost?.cacheCreationTokens ?? null,
          });
        }
      }
      // Newest first: the session a user wants to check is almost always the
      // one they just finished.
      summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return summaries;
    },

    async previewSource(accountId: number, itemKey: string): Promise<SourcePreview | null> {
      requireAccountId(accountId);
      const found = await findItem(accountId, itemKey);
      if (!found) return null;
      const verdict = found.source.admit(found.item);

      if (found.source.translate) {
        const translated = await found.source.translate(found.item);
        return {
          itemKey,
          prose: translated.map((t) => `### ${t.relPath}\n\n${t.note.body}`).join('\n\n'),
          metadata: null,
          notePaths: translated.map((t) => t.relPath),
          truncated: false,
          admitted: verdict.admitted,
          reason: verdict.reason,
        };
      }

      if (!found.source.distill) {
        return {
          itemKey,
          prose: '',
          metadata: null,
          notePaths: [],
          truncated: false,
          admitted: false,
          reason: `source ${found.source.id} cannot produce notes`,
        };
      }

      const distilled = await found.source.distill(found.item);
      return {
        itemKey,
        prose: distilled.prose,
        metadata: distilled.metadata,
        notePaths: [],
        truncated: distilled.truncated,
        admitted: verdict.admitted,
        reason: verdict.reason,
      };
    },

    async indexSource(
      accountId: number,
      itemKey: string,
      runOpts: { force?: boolean } = {},
    ): Promise<IndexResult> {
      requireAccountId(accountId);

      const found = await findItem(accountId, itemKey);
      if (!found) throw new Error(`source item not found for this account: ${itemKey}`);
      const { source, item } = found;

      // The backstop. The queue is durable across restarts, so an exclusion
      // added after an item was queued still has to stop it — and this is the
      // last point before anything is spent.
      if (isExcludedItem(accountId, item)) {
        return {
          itemKey,
          notesWritten: [],
          skipped: true,
          reason: `project is excluded from the Brain: ${item.label}`,
        };
      }

      // The session is open in another tab, so its transcript is still being
      // written. Checked BEFORE the change check and ignoring `force`: the
      // objection is not "this looks unchanged", it is "this is not finished",
      // and forcing a redo of a partial conversation only buys a different
      // partial note. Sits above every model call for the same reason the
      // exclusion backstop does.
      if (isLiveItem(item)) {
        return {
          itemKey,
          notesWritten: [],
          skipped: true,
          reason: 'session is still open in OmniFex — close the tab to index it',
        };
      }

      // Already done and nothing moved — stop before spending anything.
      //
      // This is what the mtime-then-sha256 store is FOR. Extraction asks a
      // non-deterministic model, so a re-run does not merely waste a token: it
      // returns different prose and rewrites the note, turning a stable vault
      // into churn and every re-index into a git commit. `force` keeps a
      // deliberate redo available for when the prompt or the model improves.
      const prior = sourceState.get(accountId, item.sourceId, item.itemKey);
      if (!runOpts.force && prior?.status === 'indexed' && !sourceState.hasChanged(item)) {
        return {
          itemKey,
          notesWritten: [],
          skipped: true,
          reason: 'unchanged since it was last indexed',
        };
      }

      // Gate first: a rejected item must not reach the model at all. This is
      // the only thing standing between "142 sessions" and "142 Haiku calls".
      const verdict = source.admit(item);
      if (!verdict.admitted) {
        sourceState.record(item, { status: 'skipped', error: verdict.reason });
        return { itemKey, notesWritten: [], skipped: true, reason: verdict.reason };
      }

      // Fail before spending a token, not after: an extraction whose result
      // has nowhere to go is pure waste.
      const handle = requireHandle(accountId);

      // A translating source produces finished notes with no model, so it needs
      // neither an extractor nor an owning-account config dir. The branch sits
      // before both: requiring an account here would block a source that cannot
      // spend anything through the wrong subscription in the first place.
      if (source.translate) {
        const translated = await source.translate(item);
        const written: string[] = [];
        const failures: string[] = [];
        for (const { relPath, note } of translated) {
          try {
            // The source file is the authority for a translated note — it is a
            // projection of one file, and re-translating overwrites. Change
            // detection means that only happens when the file actually changed.
            handle.vault.writeNote(relPath, note);
            handle.index.upsert(relPath, handle.vault.noteTitle(relPath), note);
            written.push(relPath);
          } catch (err) {
            failures.push(`${relPath}: ${(err as Error).message}`);
          }
        }
        const summary = failures.length > 0 ? failures.join('; ') : undefined;
        if (written.length > 0) commitAndRecord(handle, `Index ${item.sourceId}:${item.itemKey}`);
        if (written.length === 0 && failures.length > 0) {
          sourceState.record(item, { status: 'failed', error: summary });
          return { itemKey, notesWritten: [], skipped: true, reason: summary ?? 'no notes written' };
        }
        sourceState.record(item, { status: 'indexed', error: summary });
        return {
          itemKey,
          notesWritten: written,
          skipped: false,
          reason:
            failures.length > 0
              ? `${String(written.length)} note(s) written, ${String(failures.length)} failed: ${summary ?? ''}`
              : `${String(written.length)} note(s) written`,
        };
      }

      // Everything below spends tokens, so both dependencies are required from
      // here down rather than at the top of the method.
      if (!source.distill) throw new Error(`brain: source ${source.id} cannot produce notes`);
      if (!opts.extractor) throw new Error('brain: no extractor configured');
      if (!opts.accounts) throw new Error('brain: no accounts service configured');

      const account = opts.accounts.listAccounts().find((a) => a.id === accountId);
      if (!account) {
        // No silent fallback to another account's config dir — that would push
        // this account's content through the wrong subscription (spec §4).
        const reason = 'no account for this item';
        sourceState.record(item, { status: 'blocked', error: reason });
        return { itemKey, notesWritten: [], skipped: true, reason };
      }

      const distilled = await source.distill(item);

      let extraction;
      try {
        extraction = await opts.extractor(distilled, account.config_dir, {
          // Telling the model what the vault already holds is the cheap half
          // of the duplicate fix; `resolveEntityPath` below is the reliable
          // half that catches what the model still renames.
          existingNames: handle.vault.listNotes().map((p) => handle.vault.noteTitle(p)),
        });
      } catch (err) {
        // A failed extraction is a recorded status, never an exception into
        // whatever called this. A failed item must not block anything (spec §8).
        const reason = (err as Error).message;
        sourceState.record(item, { status: 'failed', error: reason });
        return { itemKey, notesWritten: [], skipped: true, reason };
      }

      const provenance = {
        sourceKey: `${item.sourceId}:${item.itemKey}`,
        // Each kind supplies the date it actually knows. A capture has its
        // capture time; a session its start; an instruction file has no event
        // date at all, so the day it was indexed is the only honest answer.
        // Every arm falls back to today rather than to another kind's field,
        // since an empty string would sort before every real date.
        date: provenanceDate(distilled.metadata),
      };

      const notesWritten: string[] = [];
      const entityErrors: string[] = [];
      // Built once per item, not per entity: it is O(vault) reads, and the
      // entities of one extraction all resolve against the same snapshot.
      const existingNotes = readExistingNotes(handle);
      for (const entity of extraction.entities) {
        // Per-entity isolation. An entity name is model-supplied and therefore
        // untrusted input for a filesystem path; `vault.notePath` rejects
        // `..`, separators and the like. One unusable entity must cost that
        // entity, not the whole item — the token has already been spent, and
        // discarding four good notes to punish a fifth bad one is the worst
        // available outcome.
        try {
          // Resolve against what the vault already holds before minting a new
          // path. `merge()` dedups by path, so without this an entity the model
          // renames on a later run becomes a second note beside the first.
          const relPath = resolveEntityPath(entity, existingNotes, (name) =>
            handle.vault.notePath(entity.type, name),
          );
          let existing: ParsedNote | null = null;
          try {
            existing = handle.vault.readNote(relPath);
          } catch {
            // Absent, or unparseable after a hand edit. Either way this merge
            // starts from nothing rather than failing the item — the spec's
            // error table isolates a broken note to that note.
            existing = null;
          }
          const merged = merge(existing, entity, provenance);
          handle.vault.writeNote(relPath, merged);
          handle.index.upsert(relPath, handle.vault.noteTitle(relPath), merged);
          notesWritten.push(relPath);
        } catch (err) {
          entityErrors.push(`${entity.name}: ${(err as Error).message}`);
        }
      }

      // One commit for the whole item, not one per note: the unit of work is
      // "indexed this session", and per-note commits would make `git revert`
      // of a bad run a multi-step operation.
      if (notesWritten.length > 0) commitAndRecord(handle, `Index ${provenance.sourceKey}`);

      const errorSummary = entityErrors.length > 0 ? entityErrors.join('; ') : undefined;

      // Recorded before the outcome branches: a run that produced nothing
      // usable still spent the money, and a ledger that only counted successes
      // would understate every month containing a bad extraction.
      recordSpend(accountId, 'index', item.sourceId, itemKey, EXTRACTION_MODEL, extraction.run);

      // Nothing usable at all is reported as skipped, so the Sources pane does
      // not claim a successful run that produced no note.
      if (notesWritten.length === 0 && entityErrors.length > 0) {
        sourceState.record(item, { status: 'failed', error: errorSummary, run: extraction.run });
        return { itemKey, notesWritten, skipped: true, reason: errorSummary ?? 'no notes written' };
      }

      // Partially written still counts as indexed: the item was processed, and
      // re-running would spend another token to arrive at the same place.
      // The run is recorded with the outcome, not separately: money is spent
      // whether or not the entities it produced turned into notes.
      sourceState.record(item, { status: 'indexed', error: errorSummary, run: extraction.run });

      const reason =
        entityErrors.length > 0
          ? `${String(notesWritten.length)} note(s) written, ${String(entityErrors.length)} entity skipped: ${errorSummary ?? ''}`
          : `${String(notesWritten.length)} note(s) written`;
      return { itemKey, notesWritten, skipped: false, reason };
    },

    async indexSelection(accountId: number, itemKeys: string[]): Promise<RunResult> {
      requireAccountId(accountId);
      // Refused before the run record is set, so a rejected call cannot strand
      // a banner with nothing left to finish it.
      if (itemKeys.length === 0) throw new Error('brain: no items in the selection');
      if (activeRun) {
        throw new Error(
          `brain: an indexing run is already in flight (${String(activeRun.completed)} of ${String(activeRun.total)})`,
        );
      }

      let written = 0;
      let skipped = 0;
      const results: IndexResult[] = [];

      activeRun = {
        accountId, total: itemKeys.length, completed: 0, item: itemKeys[0], written, skipped,
      };
      publishRun();

      try {
        for (const itemKey of itemKeys) {
          // Set before the await, so `currentRun` names the item actually in
          // flight rather than the one that finished last.
          activeRun = { ...activeRun, item: itemKey };
          try {
            const result = await service.indexSource(accountId, itemKey);
            results.push(result);
            if (result.skipped) skipped += 1;
            else written += 1;
          } catch (err) {
            // Spec §8's rule, applied to a selection: a failed item is
            // recorded and stepped over, never allowed to end the run. Shaped
            // as a skip so every item has one entry in `results` — a caller
            // iterating outcomes should not have to join two arrays to find
            // out what happened to the third item.
            results.push({
              itemKey, notesWritten: [], skipped: true, reason: (err as Error).message,
            });
            skipped += 1;
          }
          activeRun = { ...activeRun, completed: activeRun.completed + 1, written, skipped };
          publishRun();
        }
      } finally {
        // In `finally` so a throw that escapes the loop still clears the run.
        // A stuck `activeRun` would refuse every later run for the lifetime of
        // the process, with no way to reset short of restarting the app.
        activeRun = null;
        publishRun();
      }

      return { written, skipped, results };
    },

    currentRun(accountId: number): BrainRun | null {
      requireAccountId(accountId);
      // Account-scoped: another account's run is not this pane's business, and
      // showing it would attribute one account's spend to another.
      return activeRun && activeRun.accountId === accountId ? activeRun : null;
    },

    activeRun(): BrainRun | null {
      // Deliberately NOT account-scoped, unlike `currentRun`. The global
      // indicator asks "is anything indexing?" and cannot know the answer's
      // account in order to ask about it. Attribution is preserved rather than
      // dropped: the run carries its own `accountId` and the indicator names
      // the vault, so nothing is shown under the wrong account's header.
      //
      // This exposes no note content and no spend figure — only that a run
      // exists and how far along it is.
      return activeRun;
    },

    async curateNote(accountId: number, relPath: string): Promise<CurateResult> {
      requireAccountId(accountId);
      if (!opts.curator) throw new Error('brain: no curator configured');
      if (!opts.accounts) throw new Error('brain: no accounts service configured');

      const handle = requireHandle(accountId);

      let note: ParsedNote;
      try {
        note = handle.vault.readNote(relPath);
      } catch {
        // Deleted, or unparseable after a hand edit, between enqueue and claim.
        // A completed unit of work, not a failure — see the queue's skip rule.
        return { notePath: relPath, skipped: true, reason: 'note is missing or unreadable' };
      }

      const date = today();
      // Before the token, never after. The note may have been curated or
      // shortened since it was queued. Plan 4a's most expensive bug was
      // `indexSource` skipping exactly this class of check.
      if (!qualifies(note, date)) {
        return { notePath: relPath, skipped: true, reason: 'no longer qualifies for curation' };
      }

      const account = opts.accounts.listAccounts().find((a) => a.id === accountId);
      if (!account) {
        // No silent fallback to another account's config dir — that would push
        // this account's content through the wrong subscription (spec §4).
        return { notePath: relPath, skipped: true, reason: 'no account for this note' };
      }

      const entries = collapsibleEntries(note);
      // Deliberately unguarded: a rejection here propagates to the worker,
      // which records the failure against the queue entry. The note is not
      // written, so a failed curation costs tokens and not history.
      const result = await opts.curator(
        { title: handle.vault.noteTitle(relPath), noteType: note.frontmatter.type, entries },
        account.config_dir,
      );

      recordSpend(accountId, 'curation', CURATION_SOURCE_ID, relPath, CURATION_MODEL, result.run);

      const curated = curate(note, result, { date });
      handle.vault.writeNote(relPath, curated);
      handle.index.upsert(relPath, handle.vault.noteTitle(relPath), curated);
      commitAndRecord(handle, 'Curation');

      return {
        notePath: relPath,
        skipped: false,
        reason: `${String(entries.length)} entries collapsed`,
      };
    },

    enqueueCuration(accountId: number): number {
      requireAccountId(accountId);
      // `readPath` first, so an unconfigured account reports zero rather than
      // lazily materialising a vault just to find it has nothing to curate.
      const handle = readPath(accountId) === null ? null : requireHandle(accountId);
      if (!handle) return 0;

      const date = today();
      const candidates: { relPath: string; length: number }[] = [];
      for (const relPath of handle.vault.listNotes()) {
        let note: ParsedNote;
        try {
          note = handle.vault.readNote(relPath);
        } catch {
          // One unreadable note must not cost the whole run.
          continue;
        }
        if (!qualifies(note, date)) continue;
        candidates.push({ relPath, length: collapsibleEntries(note).length });
      }

      // Worst offenders first: the longest Timeline is where compression buys
      // the most context back. Ties break on path so a run is deterministic.
      candidates.sort((a, b) => b.length - a.length || a.relPath.localeCompare(b.relPath));

      const chosen = candidates.slice(0, MAX_NOTES_PER_RUN);
      for (const c of chosen) queueStore.enqueue(accountId, CURATION_SOURCE_ID, c.relPath);
      return chosen.length;
    },

    stats(accountId: number): VaultStats {
      requireAccountId(accountId);
      const handle = readPath(accountId) === null ? null : requireHandle(accountId);
      if (!handle) return computeVaultStats([], today());

      const notes: { relPath: string; note: ParsedNote }[] = [];
      for (const relPath of handle.vault.listNotes()) {
        try {
          notes.push({ relPath, note: handle.vault.readNote(relPath) });
        } catch {
          // One unreadable note must not cost the whole reading.
        }
      }
      return { ...computeVaultStats(notes, today()), spentUsd: spentUsd(accountId) };
    },

    async enqueueSource(accountId: number, itemKey: string): Promise<void> {
      requireAccountId(accountId);
      const found = await findItem(accountId, itemKey);
      // Refuse rather than enqueue blind: the queue is what later spends
      // tokens, and an item this account does not own would be indexed
      // through the wrong subscription and into the wrong vault.
      if (!found) throw new Error(`source item not found for this account: ${itemKey}`);
      // Refuse rather than silently drop: this is an explicit user action, and
      // a no-op would look like it worked.
      if (isExcludedItem(accountId, found.item)) {
        throw new Error(`project is excluded from the Brain: ${found.item.label}`);
      }
      // Same rule as the exclusion above: an explicit user action that cannot
      // succeed is refused out loud, not queued to fail quietly later.
      if (isLiveItem(found.item)) {
        throw new Error('session is still open in OmniFex — close the tab to index it');
      }
      queueStore.enqueue(accountId, found.item.sourceId, found.item.itemKey);
    },

    async enqueueProjectSources(accountId: number, projectPath: string): Promise<number> {
      requireAccountId(accountId);
      // The CLI's own encoding, which is what an auto-memory item's key is
      // qualified by. Lossy in the decode direction, but exact in this one.
      const encoded = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
      let queued = 0;

      for (const source of sources) {
        // The transcript is enqueued by its own key at the call site; this
        // covers what a session close does NOT already reach.
        if (source.id === SESSION_SOURCE_ID) continue;

        for (const item of await source.discover()) {
          if (item.accountId !== accountId) continue;
          // Auto-memory keys are `<encoded project>/<file>`; repo artifacts are
          // `<repoPath>:<file>`. Matching either shape keeps the check here
          // without teaching the caller both formats.
          const belongs =
            item.itemKey.startsWith(`${encoded}/`) || item.itemKey.startsWith(`${projectPath}:`);
          if (!belongs) continue;
          if (isExcludedItem(accountId, item)) continue;
          if (!source.admit(item).admitted) continue;
          const prior = sourceState.get(accountId, item.sourceId, item.itemKey);
          if (prior?.status === 'indexed' && !sourceState.hasChanged(item)) continue;
          queueStore.enqueue(accountId, item.sourceId, item.itemKey);
          queued += 1;
        }
      }
      return queued;
    },

    async backfill(accountId: number): Promise<number> {
      requireAccountId(accountId);
      let queued = 0;
      for (const source of sources) {
        for (const item of await source.discover()) {
          if (item.accountId !== accountId) continue;
          if (isExcludedItem(accountId, item)) continue;
          // Gate first, so the queue never holds work that would be skipped
          // the moment it was claimed.
          if (!source.admit(item).admitted) continue;
          // Already done and unmoved: `indexSource` would short-circuit
          // anyway, but keeping it out of the queue is what makes re-running
          // backfill after a partial run cost only what is left.
          const prior = sourceState.get(accountId, item.sourceId, item.itemKey);
          if (prior?.status === 'indexed' && !sourceState.hasChanged(item)) continue;
          queueStore.enqueue(accountId, item.sourceId, item.itemKey);
          queued += 1;
        }
      }
      return queued;
    },

    queueCounts(accountId?: number): QueueCounts {
      return queueStore.counts(accountId);
    },

    queueList(accountId: number, limit?: number): QueueEntry[] {
      requireAccountId(accountId);
      return queueStore.list(accountId, limit);
    },

    clearFinishedQueue(accountId: number): void {
      requireAccountId(accountId);
      queueStore.clearFinished(accountId);
    },

    async drainQueue(): Promise<DrainOutcome> {
      // A manual selection owns `activeRun` exclusively — `indexSelection`
      // refuses to start while one is in flight, and the queue has to be just
      // as polite in the other direction, or a timed drain would silently
      // overwrite the banner the user is watching.
      if (activeRun) return { processed: 0, yielded: true, reason: 'busy' };

      queueRunStats = { completed: 0, written: 0, skipped: 0 };
      try {
        return await queueWorker.drain();
      } finally {
        activeRun = null;
        publishRun();
      }
    },

    queueCurrent(): QueueEntry | null {
      return queueWorker.current();
    },

    closeAll(): void {
      for (const accountId of [...handles.keys()]) closeHandle(accountId);
    },
  };

  return service;
}
