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
import { countOffloadedFiles } from './offloaded';
import { canonicalPath, fsIdentity, isSameOrInside, resolveVaultRoot } from './paths';
import { createSourceStateStore, type SourceStatus } from './sources/state';
import {
  CURATION_SOURCE_ID,
  DEFAULT_IDLE_MINUTES,
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
import { projectLinkFor } from './project';
import { toNoteMeta, type NoteMeta } from './note-meta';
import { NOTE_FOLDERS } from './types';
import { merge } from './merge';
import {
  MAX_NOTES_PER_RUN,
  collapsibleDecisions,
  collapsibleEntries,
  curate,
  qualifies,
} from './curate';
import type { Curator } from './curation';
import { computeVaultStats, type VaultStats } from './stats';
import { isExcludedProject, parseDecisions, type ProjectDecisions } from './exclusions';
import type { AccountsService } from '../accounts';
import { mapLimit } from '../util/map-limit';
import type { ParsedNote } from './types';

/** A vault root must not overlap another account's, and its index must be its own. */
export class VaultConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultConflictError';
  }
}

export function vaultSettingKey(accountId: number): string {
  return `brain.vault.${accountId}`;
}

/** Only `brain.vault.<digits>` keys are vault paths; other settings share the prefix. */
const VAULT_KEY_RE = /^brain\.vault\.\d+$/;

/** An absent entry means no decision (the exclusions.ts default applies), never "included". */
export function excludedProjectsKey(accountId: number): string {
  return `brain.excludedProjects.${String(accountId)}`;
}

const INDEX_DIR = '.omnifex';
const INDEX_FILE = 'index.db';

const GIT_DIR = '.git';

/** A malformed accountId is a confidentiality risk, and it must agree with vaultSettingKey's coercion or one DB gets two handles. */
function requireAccountId(accountId: number): number {
  if (!Number.isSafeInteger(accountId) || accountId < 1) {
    throw new Error(`invalid accountId: ${String(accountId)}`);
  }
  return accountId;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

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
  /** Joinable `git init`; never rejects, or every unawaited handle raises an unhandled rejection. */
  readonly gitReady: Promise<void>;
}

/** Answerable without creating the vault: never materialize to look. */
export interface VaultStatus {
  accountId: number;
  configured: boolean;
  path: string | null;
  exists: boolean;
  initialized: boolean;
  noteCount: number;
  indexedCount: number | null;
  gitAvailable: boolean;
  lastGitError: string | null;
  conflict: string | null;
  /** Null is "not determined", never zero. */
  offloadedCount: number | null;
}

export interface SourceSummary {
  accountId: number;
  sourceId: string;
  itemKey: string;
  /** Never a full path: the project column already carries the folder. */
  name: string;
  /** An open session is still being written; indexing it would record half a conversation as done. */
  inUse: boolean;
  label: string;
  mtimeMs: number;
  size: number;
  admitted: boolean;
  reason: string;
  status: SourceStatus | null;
  changed: boolean;
  excluded: boolean;
  /** Null means nothing was ever spent, not that a run was free. */
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

export interface IndexResult {
  itemKey: string;
  notesWritten: string[];
  skipped: boolean;
  reason: string;
}

export type BrainRunPhase =
  | 'preparing'
  | 'distilling'
  | 'extracting'
  | 'writing'
  | 'curating';

export interface BrainRun {
  accountId: number;
  total: number;
  /** Terminal so far: finished, not started. */
  completed: number;
  item: string;
  label: string;
  phase: BrainRunPhase;
  /** Restamped per item: a long backfill's start says nothing about whether this item is stuck. */
  startedAt: number;
  written: number;
  skipped: number;
}

export interface RunResult {
  written: number;
  skipped: number;
  /** Per item, including throws as skips. Whole-run failures (no vault, run in flight) reject instead. */
  results: IndexResult[];
}

export interface CurateResult {
  notePath: string;
  skipped: boolean;
  reason: string;
}

/** `metadata` is null for a translating source; never fabricate one. */
export interface SourcePreview {
  itemKey: string;
  prose: string;
  metadata: ItemMetadata | null;
  notePaths: string[];
  truncated: boolean;
  admitted: boolean;
  reason: string;
}

export interface BackfillOptions {
  /** Omitted by the Backfill button; the periodic sweep must supply it. */
  sinceMs?: number;
}

export interface BrainService {
  vaultPath(accountId: number): string | null;
  setVaultPath(accountId: number, path: string): void;
  clearVaultPath(accountId: number): void;
  open(accountId: number): VaultHandle | null;
  /** Never creates the vault, never throws for a broken one. */
  status(accountId: number): Promise<VaultStatus>;
  search(accountId: number, query: string, opts?: SearchOptions): SearchHit[];
  backlinks(accountId: number, relPath: string): string[];
  writeNote(accountId: number, relPath: string, note: ParsedNote, commitMessage: string): void;
  rebuild(accountId: number): number;
  deleteNote(accountId: number, relPath: string): void;
  updateNoteBody(accountId: number, relPath: string, body: string): ParsedNote;
  /** Filtered after discovery: adapters derive ownership, so they never accept an accountId. */
  listSources(accountId: number, opts?: { includeExcluded?: boolean }): Promise<SourceSummary[]>;
  /** A complete map, not a list of exclusions: an absent key re-applies the temp default. */
  setExcludedProjects(accountId: number, decisions: ProjectDecisions): void;
  previewSource(accountId: number, itemKey: string): Promise<SourcePreview | null>;
  /** Resolves for gate rejections and failed extractions (recorded outcomes); throws for caller mistakes. */
  indexSource(
    accountId: number,
    itemKey: string,
    opts?: { force?: boolean },
  ): Promise<IndexResult>;
  /** Exactly `itemKeys`, never a queue drain; concurrency 1; per-item failures collected, never thrown. */
  indexSelection(
    accountId: number,
    itemKeys: string[],
    opts?: { force?: boolean },
  ): Promise<RunResult>;
  currentRun(accountId: number): BrainRun | null;
  activeRun(): BrainRun | null;
  /** Re-checks `qualifies` before spending: a note can change between enqueue and claim. */
  curateNote(accountId: number, relPath: string): Promise<CurateResult>;
  enqueueCuration(accountId: number): number;
  enqueueSource(accountId: number, itemKey: string): Promise<void>;
  /** Matches on each item's own key: key formats belong to the adapters. */
  enqueueProjectSources(accountId: number, projectPath: string): Promise<number>;
  backfill(accountId: number, opts?: BackfillOptions): Promise<number>;
  /** Zeroes when unconfigured, never a throw. */
  stats(accountId: number): VaultStats;
  /** A sibling of stats(), not a widening of listNotes(): the hot paths want paths only. */
  listNoteMeta(accountId: number): NoteMeta[];
  queueCounts(accountId?: number): QueueCounts;
  queueList(accountId: number, limit?: number): QueueEntry[];
  clearFinishedQueue(accountId: number): void;
  /** Never throws. */
  drainQueue(): Promise<DrainOutcome>;
  queueCurrent(): QueueEntry | null;
  closeAll(): void;
}

/** Keyed on on-disk identity, not the name: a name can come to mean a different file. */
interface CachedHandle {
  readonly handle: VaultHandle;
  /** Never null: an unreadable identity is not cached, so two missing objects never compare equal. */
  readonly identity: string;
}

/** Null when either object is missing: a miss, so a deleted index rebuilds rather than writing to an unlinked inode. */
function handleIdentity(root: string, indexFile: string): string | null {
  const rootId = fsIdentity(root);
  const indexId = fsIdentity(indexFile);
  return rootId === null || indexId === null ? null : `${rootId}|${indexId}`;
}

/**
 * Refuses an index directory containing any symlink or hard link (nlink > 1) — every entry, not just
 * index.db: a linked WAL sidecar leaks another vault's bodies just as completely. lstat-based, because
 * better-sqlite3 creates a dangling link's target inside the other vault.
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

/** A symlinked `.git` or a gitfile would commit this vault's notes into another account's history. Absence is fine. */
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
      // Unparseable frontmatter is surfaced elsewhere.
    }
  }
  return out;
}

/** `open()` is the only producer of a VaultHandle, and it always re-validates overlap: the cache may skip construction, never validation. */
export interface BrainServiceOptions {
  execGit?: ExecGit;
  sources?: BrainSource[];
  /** Required by `indexSource`, which fails loudly without it. */
  accounts?: AccountsService;
  /** Absent means indexing is unavailable. */
  extractor?: Extractor;
  /** Absent: `curateNote` throws rather than silently no-opping. */
  curator?: Curator;
  isQueuePaused?: () => boolean;
  /** The indexer's only session-awareness: which transcripts are still being written. */
  liveSessionIds?: () => Iterable<string>;
  /** A getter, so a setting change applies without a restart. */
  idleMs?: () => number;
  now?: () => number;
  /** The terminating `null` is load-bearing: without it a pane hangs on the last frame. */
  onRunProgress?: (run: BrainRun | null) => void;
  countOffloaded?: (root: string) => Promise<number | null>;
}

/** Bounded: each check may use libuv's four-worker thread pool. */
const LIST_CONCURRENCY = 4;

export function createBrainService(
  db: Database,
  opts: BrainServiceOptions = {},
): BrainService {
  // Invalidated when the path moves or names a different directory.
  const handles = new Map<number, CachedHandle>();

  const lastGitError = new Map<number, string>();

  const sources = opts.sources ?? [];
  const clock = opts.now ?? Date.now;
  // The shipped threshold, never zero: an unwired reader must behave like the product.
  const idleMs = opts.idleMs ?? (() => DEFAULT_IDLE_MINUTES * 60_000);
  const countOffloaded = opts.countOffloaded ?? countOffloadedFiles;
  const sourceState = createSourceStateStore(db);
  const queueStore = createBrainQueueStore(db);
  const spendStore = createBrainSpendStore(db);

  /** Swallows its own failure: a lost ledger row must never lose the note. The `run` guard stops non-model paths inventing a payment. */
  function recordSpend(
    accountId: number,
    kind: SpendKind,
    sourceId: string | null,
    itemKey: string,
    requestedModel: string,
    run: RunCost | undefined,
  ): void {
    if (!run) return;
    // What billed, not the alias asked for: the ledger must stay attributable.
    const model = run.model ?? requestedModel;
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

  // One run at a time across all accounts: the rate limit is shared.
  let activeRun: BrainRun | null = null;

  /** A throwing subscriber (a closed window) must never abort paid-for work. */
  function publishRun(): void {
    if (!opts.onRunProgress) return;
    try {
      opts.onRunProgress(activeRun);
    } catch (err) {
      console.warn('[brain] run progress subscriber threw:', (err as Error).message);
    }
  }

  /** Guarded on item key: a direct `indexSource` call must not repaint the queue's stage. */
  function setRunPhase(itemKey: string, phase: BrainRunPhase, label?: string): void {
    if (activeRun?.item !== itemKey) return;
    activeRun = { ...activeRun, phase, ...(label === undefined ? {} : { label }) };
    publishRun();
  }

  // Without this, one bad shutdown leaves a row running forever and the queue stops draining.
  const orphans = queueStore.recoverOrphans();
  if (orphans > 0) console.warn(`brain: recovered ${String(orphans)} orphaned queue entries`);

  let queueRunStats = { completed: 0, written: 0, skipped: 0 };

  function runTotal(): number {
    return queueRunStats.completed + 1 + queueStore.counts().pending;
  }

  /** Only queue runs count against the queue depth in `widenRunTotal`. */
  let runOwner: 'queue' | 'selection' | null = null;

  /** Silent when unchanged (enqueue is idempotent), and always for a selection, whose total is the rows ticked. */
  function widenRunTotal(): void {
    if (!activeRun || runOwner !== 'queue') return;
    const total = runTotal();
    if (total === activeRun.total) return;
    activeRun = { ...activeRun, total };
    publishRun();
  }

  /** Every enqueue goes through here, so the queue never grows silently. */
  function enqueueItem(accountId: number, sourceId: string, itemKey: string): void {
    queueStore.enqueue(accountId, sourceId, itemKey);
    widenRunTotal();
  }

  const queueWorker = createBrainQueueWorker({
    store: queueStore,
    // Through the service's own methods, so every drain gets the unchanged-item, isolation and re-qualification checks.
    process: async (entry) => {
      // Recomputed per entry so a mid-drain enqueue widens the bar; +1 for the claimed entry.
      runOwner = 'queue';
      activeRun = {
        accountId: entry.accountId,
        total: runTotal(),
        completed: queueRunStats.completed,
        item: entry.itemKey,
        label: entry.itemKey,
        phase: 'preparing',
        startedAt: clock(),
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
        // A rate-limited item goes back untouched; never count it.
        if (!isRateLimitError((err as Error).message)) queueRunStats.skipped += 1;
        else queueRunStats.completed -= 1;
        throw err;
      } finally {
        queueRunStats.completed += 1;
      }
    },
    isPaused: opts.isQueuePaused ?? (() => false),
  });

  /** By account AND key: a session id is unique only per account. */
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

  /** Swallows a throwing provider: the listing must render, and indexSource enforces the money path. */
  function liveSessions(): Set<string> {
    try {
      return new Set(opts.liveSessionIds?.() ?? []);
    } catch {
      return new Set();
    }
  }

  /** Open is not enough: an item is live only if also written within the idle threshold, or open tabs hold transcripts out forever. */
  function isLiveItem(
    item: SourceItem,
    live: Set<string> = liveSessions(),
    at: number = clock(),
  ): boolean {
    if (item.sourceId !== SESSION_SOURCE_ID) return false;
    if (!live.has(item.itemKey)) return false;
    return at - item.mtimeMs < idleMs();
  }

  function displayName(item: SourceItem): string {
    if (item.sourceId === SESSION_SOURCE_ID) return item.itemKey;
    const base = item.path ? basename(item.path) : '';
    return base || item.itemKey;
  }

  function runLabel(item: SourceItem): string {
    if (item.sourceId !== SESSION_SOURCE_ID) return displayName(item);
    return basename(item.label) || item.label || item.itemKey;
  }

  /** From `brain_spend`, never `brain_sources` (a per-item snapshot re-indexing overwrites). Scoped by account. */
  function spentUsd(accountId: number): number {
    return spendStore.total(accountId);
  }

  function readPath(accountId: number): string | null {
    return db.getSetting(vaultSettingKey(accountId));
  }

  function readDecisions(accountId: number): ProjectDecisions {
    return parseDecisions(db.getSetting(excludedProjectsKey(accountId)));
  }

  /** Applied at every path that can reach the model: the queue outlives an exclusion added later. */
  function isExcludedItem(accountId: number, item: SourceItem): boolean {
    return isExcludedProject(item.label, readDecisions(accountId));
  }

  /** Fire-and-forget, but the result is recorded: a failing commit must be visible. */
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

  /** The key shape decides, not the prefix: other settings share it. */
  function otherVaultRows(accountId: number): { key: string; value: string }[] {
    const rows = db.raw
      .prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'brain.vault.%'`)
      .all() as { key: string; value: string }[];
    return rows.filter((row) => VAULT_KEY_RE.test(row.key) && row.key !== vaultSettingKey(accountId));
  }

  /** Rejects equal, containing or contained paths: a nested vault leaks notes into the outer account. */
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

  /** Never falls back to another account's vault. */
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
      // Judge the string before any filesystem effect: '' is cwd and `~` is literal.
      const resolved = resolveVaultRoot(path);

      // Materialize first: canonicalization only sees real identity for existing segments.
      let created: string | undefined;
      try {
        created = mkdirSync(resolved, { recursive: true });
      } catch (err) {
        // Swallowing this would fall back to a lexical comparison, the alias bypass this stops.
        throw new Error(`cannot create vault directory: ${resolved} (${(err as Error).message})`);
      }

      try {
        assertNoOverlap(accountId, canonicalPath(resolved));
      } catch (err) {
        if (created) rmSync(created, { recursive: true, force: true });
        throw err;
      }

      closeHandle(accountId);
      // Store the resolved path (a relative one re-resolves against a later cwd), not the canonical one.
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
      if (!path) return null;

      // Re-validate on read: app_settings can be written directly. Invalid reads as unconfigured.
      let root: string;
      try {
        root = resolveVaultRoot(path);
      } catch {
        return null;
      }

      // THE GUARD: unconditional and first, before the cache and before any write. Judge both the root and the index database.
      let indexFile: string;
      try {
        assertNoOverlap(accountId, canonicalPath(root));
        assertOwnGitDir(root);
        indexFile = ensureVaultIndexPath(root);
      } catch (err) {
        // Fail closed: an unsafe handle must not keep a SQLite descriptor on another account's vault.
        closeHandle(accountId);
        throw err;
      }

      // Reuse only when the name and the objects it reaches both match.
      const cached = handles.get(accountId);
      if (cached?.identity === handleIdentity(root, indexFile) && cached.handle.root === root) {
        return cached.handle;
      }
      if (cached) closeHandle(accountId);

      const vault = createVault(root);
      vault.ensureLayout();

      const git = createVaultGit(vault.root, opts.execGit);
      // A missing git must not block a write; the promise is retained so callers can join the init.
      const gitReady = git.init().catch((err: unknown) => {
        console.warn('brain: git init failed:', err);
      });

      const index = createVaultIndex(indexFile);

      const handle: VaultHandle = { accountId, root: vault.root, vault, index, git, gitReady };
      // Re-read after the index file exists; an unidentifiable handle is never cached.
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
        gitAvailable: await createVaultGit(process.cwd()).available(),
        lastGitError: lastGitError.get(accountId) ?? null,
        conflict: null,
        offloadedCount: null,
      };
      if (stored === null) return base;

      // Report, never throw: this method exists to describe broken states.
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
        offloadedCount: await countOffloaded(root),
      };
    },

    search(accountId: number, query: string, opts?: SearchOptions): SearchHit[] {
      requireAccountId(accountId);
      let handle: VaultHandle | null;
      try {
        handle = service.open(accountId);
      } catch (err) {
        // The overlap test is symmetric, so a read degrades to empty rather than throw at the unchanged account. Writes still fail closed.
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
      let handle: VaultHandle | null;
      try {
        handle = service.open(accountId);
      } catch (err) {
        if (err instanceof VaultConflictError) return [];
        throw err;
      }
      if (!handle) return [];

      // A full scan, not the FTS index: it is stemmed and limited, and would silently miss links.
      const out: string[] = [];
      for (const candidate of handle.vault.listNotes()) {
        if (candidate === relPath) continue;
        let body: string;
        try {
          body = handle.vault.readNote(candidate).body;
        } catch {
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
      // Read-modify-write: the renderer must never rewrite type, provenance or sources.
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
      // Key-sorted so the stored value is stable.
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
      // One snapshot for the whole listing.
      const live = liveSessions();
      const summaries: SourceSummary[] = [];
      for (const source of sources) {
        // The account scope: another account's project names must never reach this UI.
        const listed = (await source.discover()).filter(
          (item) =>
            item.accountId === accountId &&
            (opts.includeExcluded === true || !isExcludedProject(item.label, decisions)),
        );
        // Bounded: an unbounded Promise.all starves every other fs call.
        const rows = await mapLimit(listed, LIST_CONCURRENCY, async (item): Promise<SourceSummary> => {
          const verdict = await source.admit(item);
          const prior = sourceState.get(accountId, item.sourceId, item.itemKey);
          return {
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
            changed: await sourceState.hasChanged(item),
            excluded: isExcludedProject(item.label, decisions),
            costUsd: prior?.cost?.costUsd ?? null,
            inputTokens: prior?.cost?.inputTokens ?? null,
            outputTokens: prior?.cost?.outputTokens ?? null,
            cacheReadTokens: prior?.cost?.cacheReadTokens ?? null,
            cacheCreationTokens: prior?.cost?.cacheCreationTokens ?? null,
          };
        });
        summaries.push(...rows);
      }
      summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return summaries;
    },

    async previewSource(accountId: number, itemKey: string): Promise<SourcePreview | null> {
      requireAccountId(accountId);
      const found = await findItem(accountId, itemKey);
      if (!found) return null;
      const verdict = await found.source.admit(found.item);

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

      setRunPhase(itemKey, 'preparing', runLabel(item));

      // Backstop: an exclusion added after queueing must still stop the item before any spend.
      if (isExcludedItem(accountId, item)) {
        return {
          itemKey,
          notesWritten: [],
          skipped: true,
          reason: `project is excluded from the Brain: ${item.label}`,
        };
      }

      // A live transcript is skipped even with `force`: redoing a partial conversation only buys another partial note.
      if (isLiveItem(item)) {
        return {
          itemKey,
          notesWritten: [],
          skipped: true,
          reason: 'session is active in OmniFex — it will index once it goes idle',
        };
      }

      // Unchanged and indexed: stop. A re-run rewords the note and makes a commit; `force` allows a deliberate redo.
      const prior = sourceState.get(accountId, item.sourceId, item.itemKey);
      if (!runOpts.force && prior?.status === 'indexed' && !(await sourceState.hasChanged(item))) {
        return {
          itemKey,
          notesWritten: [],
          skipped: true,
          reason: 'unchanged since it was last indexed',
        };
      }

      // Gate before the model. `force` comes only from a person's explicit press; the sweep never sets it.
      const verdict = await source.admit(item);
      if (!verdict.admitted && !runOpts.force) {
        await sourceState.record(item, { status: 'skipped', error: verdict.reason });
        return { itemKey, notesWritten: [], skipped: true, reason: verdict.reason };
      }

      // Fail before spending a token.
      const handle = requireHandle(accountId);

      // Translating sources spend nothing, so they need neither an extractor nor an account.
      if (source.translate) {
        setRunPhase(itemKey, 'writing');
        const translated = await source.translate(item);
        const written: string[] = [];
        const failures: string[] = [];
        for (const { relPath, note } of translated) {
          try {
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
          await sourceState.record(item, { status: 'failed', error: summary });
          return { itemKey, notesWritten: [], skipped: true, reason: summary ?? 'no notes written' };
        }
        await sourceState.record(item, { status: 'indexed', error: summary });
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

      if (!source.distill) throw new Error(`brain: source ${source.id} cannot produce notes`);
      if (!opts.extractor) throw new Error('brain: no extractor configured');
      if (!opts.accounts) throw new Error('brain: no accounts service configured');

      const account = opts.accounts.listAccounts().find((a) => a.id === accountId);
      if (!account) {
        // Never fall back to another account's config dir.
        const reason = 'no account for this item';
        await sourceState.record(item, { status: 'blocked', error: reason });
        return { itemKey, notesWritten: [], skipped: true, reason };
      }

      setRunPhase(itemKey, 'distilling');
      const distilled = await source.distill(item);

      let extraction;
      try {
        setRunPhase(itemKey, 'extracting');
        extraction = await opts.extractor(distilled, account.config_dir, {
          existingNames: handle.vault.listNotes().map((p) => handle.vault.noteTitle(p)),
        });
      } catch (err) {
        // A failed extraction is a recorded status, never an exception: it must not block anything.
        const reason = (err as Error).message;
        await sourceState.record(item, { status: 'failed', error: reason });
        return { itemKey, notesWritten: [], skipped: true, reason };
      }

      setRunPhase(itemKey, 'writing');

      const existingNotes = readExistingNotes(handle);

      const provenance = {
        sourceKey: `${item.sourceId}:${item.itemKey}`,
        // Every arm falls back to today, never another kind's field: an empty string sorts before every date.
        date: provenanceDate(distilled.metadata),
        projectLink: projectLinkFor(
          distilled.metadata,
          existingNotes.filter((n) => n.path.startsWith(`${NOTE_FOLDERS.Project}/`)),
        ),
      };

      const notesWritten: string[] = [];
      const entityErrors: string[] = [];
      for (const entity of extraction.entities) {
        // Per-entity isolation: one bad model-supplied name costs that entity, not the item.
        try {
          // Resolve before minting: merge dedups by path, so a renamed entity would become a second note.
          const relPath = resolveEntityPath(entity, existingNotes, (name) =>
            handle.vault.notePath(entity.type, name),
          );
          let existing: ParsedNote | null = null;
          try {
            existing = handle.vault.readNote(relPath);
          } catch {
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

      // One commit per item, so reverting a bad run is one step.
      if (notesWritten.length > 0) commitAndRecord(handle, `Index ${provenance.sourceKey}`);

      const errorSummary = entityErrors.length > 0 ? entityErrors.join('; ') : undefined;

      // Recorded before the outcome branches: a run that produced nothing still spent the money.
      recordSpend(accountId, 'index', item.sourceId, itemKey, EXTRACTION_MODEL, extraction.run);

      if (notesWritten.length === 0 && entityErrors.length > 0) {
        await sourceState.record(item, { status: 'failed', error: errorSummary, run: extraction.run });
        return { itemKey, notesWritten, skipped: true, reason: errorSummary ?? 'no notes written' };
      }

      // Partially written still counts as indexed: a re-run would spend again to reach the same place.
      await sourceState.record(item, { status: 'indexed', error: errorSummary, run: extraction.run });

      const reason =
        entityErrors.length > 0
          ? `${String(notesWritten.length)} note(s) written, ${String(entityErrors.length)} entity skipped: ${errorSummary ?? ''}`
          : `${String(notesWritten.length)} note(s) written`;
      return { itemKey, notesWritten, skipped: false, reason };
    },

    async indexSelection(
      accountId: number,
      itemKeys: string[],
      opts: { force?: boolean } = {},
    ): Promise<RunResult> {
      requireAccountId(accountId);
      // Refused before the run record is set, so a rejected call cannot strand a banner.
      if (itemKeys.length === 0) throw new Error('brain: no items in the selection');
      if (activeRun) {
        throw new Error(
          `brain: an indexing run is already in flight (${String(activeRun.completed)} of ${String(activeRun.total)})`,
        );
      }

      let written = 0;
      let skipped = 0;
      const results: IndexResult[] = [];

      runOwner = 'selection';
      activeRun = {
        accountId, total: itemKeys.length, completed: 0, item: itemKeys[0],
        label: itemKeys[0], phase: 'preparing', startedAt: clock(), written, skipped,
      };
      publishRun();

      try {
        for (const itemKey of itemKeys) {
          // Every per-item field resets together, before the await.
          activeRun = {
            ...activeRun, item: itemKey, label: itemKey,
            phase: 'preparing', startedAt: clock(),
          };
          try {
            const result = await service.indexSource(accountId, itemKey, opts);
            results.push(result);
            if (result.skipped) skipped += 1;
            else written += 1;
          } catch (err) {
            // A failed item is recorded as a skip and stepped over, never ends the run.
            results.push({
              itemKey, notesWritten: [], skipped: true, reason: (err as Error).message,
            });
            skipped += 1;
          }
          activeRun = { ...activeRun, completed: activeRun.completed + 1, written, skipped };
          publishRun();
        }
      } finally {
        // In `finally`: a stuck activeRun refuses every later run until restart.
        activeRun = null;
        runOwner = null;
        publishRun();
      }

      return { written, skipped, results };
    },

    currentRun(accountId: number): BrainRun | null {
      requireAccountId(accountId);
      // Account-scoped: never attribute one account's run to another.
      return activeRun?.accountId === accountId ? activeRun : null;
    },

    activeRun(): BrainRun | null {
      // Deliberately not account-scoped: the run carries its own accountId.
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
        // A completed unit of work, not a failure.
        return { notePath: relPath, skipped: true, reason: 'note is missing or unreadable' };
      }

      const date = today();
      // Re-check before the token: the note may have changed since it was queued.
      if (!qualifies(note, date)) {
        return { notePath: relPath, skipped: true, reason: 'no longer qualifies for curation' };
      }

      const account = opts.accounts.listAccounts().find((a) => a.id === accountId);
      if (!account) {
        // Never fall back to another account's config dir.
        return { notePath: relPath, skipped: true, reason: 'no account for this note' };
      }

      setRunPhase(relPath, 'curating', handle.vault.noteTitle(relPath));

      const entries = collapsibleEntries(note);
      const decisions = collapsibleDecisions(note);
      // Unguarded on purpose: the worker records the failure, and the note is not written.
      const result = await opts.curator(
        {
          title: handle.vault.noteTitle(relPath),
          noteType: note.frontmatter.type,
          entries,
          decisions,
        },
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
      // `readPath` first, so an unconfigured account never materializes a vault.
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
        candidates.push({
          relPath,
          length: collapsibleEntries(note).length + collapsibleDecisions(note).length,
        });
      }

      // Rank on both sections, ties by path, so a run is deterministic.
      candidates.sort((a, b) => b.length - a.length || a.relPath.localeCompare(b.relPath));

      const chosen = candidates.slice(0, MAX_NOTES_PER_RUN);
      for (const c of chosen) enqueueItem(accountId, CURATION_SOURCE_ID, c.relPath);
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

    listNoteMeta(accountId: number): NoteMeta[] {
      requireAccountId(accountId);
      const handle = readPath(accountId) === null ? null : requireHandle(accountId);
      if (!handle) return [];

      const out: NoteMeta[] = [];
      for (const relPath of handle.vault.listNotes()) {
        try {
          out.push(toNoteMeta(relPath, handle.vault.readNote(relPath)));
        } catch {
          // One unreadable note must not cost the whole listing.
        }
      }
      return out;
    },

    async enqueueSource(accountId: number, itemKey: string): Promise<void> {
      requireAccountId(accountId);
      const found = await findItem(accountId, itemKey);
      // Never enqueue an item this account does not own: it would index into the wrong vault.
      if (!found) throw new Error(`source item not found for this account: ${itemKey}`);
      // Refuse out loud: a no-op would look like it worked.
      if (isExcludedItem(accountId, found.item)) {
        throw new Error(`project is excluded from the Brain: ${found.item.label}`);
      }
      if (isLiveItem(found.item)) {
        throw new Error('session is active in OmniFex — it will index once it goes idle');
      }
      enqueueItem(accountId, found.item.sourceId, found.item.itemKey);
    },

    async enqueueProjectSources(accountId: number, projectPath: string): Promise<number> {
      requireAccountId(accountId);
      // The CLI's encoding: lossy to decode, exact in this direction.
      const encoded = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
      let queued = 0;

      for (const source of sources) {
        // The session close enqueues the transcript itself.
        if (source.id === SESSION_SOURCE_ID) continue;

        for (const item of await source.discover()) {
          if (item.accountId !== accountId) continue;
          // Key formats: auto-memory `<encoded>/<file>`, repo artifacts `<repoPath>:<file>`.
          const belongs =
            item.itemKey.startsWith(`${encoded}/`) || item.itemKey.startsWith(`${projectPath}:`);
          if (!belongs) continue;
          if (isExcludedItem(accountId, item)) continue;
          if (!(await source.admit(item)).admitted) continue;
          const prior = sourceState.get(accountId, item.sourceId, item.itemKey);
          if (prior?.status === 'indexed' && !(await sourceState.hasChanged(item))) continue;
          enqueueItem(accountId, item.sourceId, item.itemKey);
          queued += 1;
        }
      }
      return queued;
    },

    async backfill(accountId: number, opts: BackfillOptions = {}): Promise<number> {
      requireAccountId(accountId);
      const live = liveSessions();
      const at = clock();
      let queued = 0;
      for (const source of sources) {
        for (const item of await source.discover()) {
          if (item.accountId !== accountId) continue;
          if (isExcludedItem(accountId, item)) continue;
          // Live first, before the change check: otherwise every tick hashes the streaming session in full.
          if (isLiveItem(item, live, at)) continue;
          const prior = sourceState.get(accountId, item.sourceId, item.itemKey);
          // The sweep's horizon (absent for Backfill) never strands a known item whose bytes moved.
          const knownAndChanged = prior !== null && (await sourceState.hasChanged(item));
          if (
            !knownAndChanged &&
            opts.sinceMs !== undefined &&
            item.mtimeMs < opts.sinceMs
          ) {
            continue;
          }
          if (prior?.status === 'indexed' && !knownAndChanged) continue;
          // Gate last: admit() reads the whole transcript, so cheap checks go first. Safe because admit() has no side effects.
          if (!(await source.admit(item)).admitted) continue;
          enqueueItem(accountId, item.sourceId, item.itemKey);
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
      // A manual selection owns activeRun exclusively; a timed drain must not overwrite its banner.
      if (activeRun) return { processed: 0, yielded: true, reason: 'busy' };

      queueRunStats = { completed: 0, written: 0, skipped: 0 };
      try {
        let outcome = await queueWorker.drain();
        // Catch an enqueue that landed after the last claim. Not while yielded: a rate limit parks the queue.
        while (!outcome.yielded && queueStore.counts().pending > 0) {
          const again = await queueWorker.drain();
          if (again.processed === 0) break;
          outcome = { ...again, processed: outcome.processed + again.processed };
        }
        return outcome;
      } finally {
        activeRun = null;
        runOwner = null;
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
