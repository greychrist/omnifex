# Brain Session Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the session-transcript source adapter — `discover()`, `admit()`, `distill()` — with **no LLM anywhere**, plus a Sources pane in the Brain tab so the distilled output can be inspected before Plan 4 spends a token on it.

**Architecture:** A `BrainSource` adapter walks every account's `<config_dir>/projects/*/​*.jsonl`, derives each transcript's owning account from the config dir it lives under (never from `resolve()`), and records what it has seen in the existing `brain_sources` table using Rowboat's hybrid mtime-then-sha256 change detection. A deterministic admission gate drops noise sessions with a stated reason. A pure `distill()` reduces a transcript to prompts + assistant prose + structured metadata under an 8KB ceiling, never letting tool results, file contents or diffs reach the model. Everything is a pure function over text except `discover()`, which is the only thing that touches the filesystem.

**Tech Stack:** TypeScript, Electron main process, `better-sqlite3` (existing `brain_sources` table, schema v18), Vitest, React 18 + Tailwind v4 for the Sources pane.

## Global Constraints

- **This step spends zero tokens.** No `AgentEngine` call, no CLI spawn, no model of any kind. Step 3 of the spec's build sequence exists precisely so distillation quality can be judged before Plan 4's first LLM spend. A task that reaches for a model has misread the plan.
- **The account that owns a source is the account that indexes it and the account whose vault receives it** (spec §4). Transcript ownership derives from `getAccountByConfigDir()` on the config dir the file lives under — never from `resolve()`, never from a caller-supplied default.
- **No silent default-account fallback.** An item whose owning account cannot be determined is recorded as `blocked` and surfaced; it is never attributed to another account.
- **The Brain is auxiliary.** Nothing here may break a session, block the UI, or throw out of an IPC handler in a way that crashes the main process.
- **The model must never see raw JSONL** (spec §6). `distill()` drops tool results, file contents, diffs, thinking blocks and attachments entirely.
- Ceiling is **~8KB per session**, truncating **oldest-first** with an explicit marker so a downstream reader knows it is seeing a tail (spec §6).
- Turns anchor on the **user prompt**, not on assistant-message adjacency (spec §6, matching `src/lib/turnDelta.ts`).
- TDD is required: failing test first, then implementation. Backend coverage target is 80% lines.
- Every new invoke channel goes in `electron/ipc/channels.ts` (which feeds the `preload.ts` allow-list) **and** `src/lib/api.ts`. Handler adapters accept both camelCase and snake_case.
- Strip `undefined` optional params before crossing IPC (`stripUndefined` in `src/lib/api.ts`).
- Verification gate for this branch is cross-cutting: `npm run check`, `npm run build`, `npm run test:coverage`, then `npm run rebuild:electron` before the app is restarted (vitest leaves `better-sqlite3` built for Node).

## Prior Art To Read Before Starting

- `docs/superpowers/specs/2026-08-11-brain-memory-vault-design.md` §4 (multi-account), §5 (source adapters), §6 (distillation), §7 (admission gate), §16 (services and wiring).
- `electron/services/sessions-summary.ts:141-227` — `extractTranscript` / `truncateForModel`. **Deliberately not reused.** That pair serves a different contract: it keeps a 720KB head+tail window for a full-fidelity summary of one session the user asked about. `distill()` needs an 8KB oldest-first tail with structured metadata alongside. The two are siblings, not a shared abstraction; read it for the JSONL row shapes it already handles, not to call it.
- `src/lib/jsonlClassifier.ts:138-168` — the renderer's authoritative user-row classification. **Cannot be imported from `electron/`**: it imports `@/types/jsonl`, and `tsconfig.electron.json` defines no `paths` alias, so importing it breaks `npm run check`. `src/lib/pricing.ts` is the counter-example of a module written to be shared across both tsconfigs (alias-free, Node- and DOM-free); `jsonlClassifier.ts` is not one. Task 3 reimplements only the narrow predicate it needs, on the same twins-with-a-comment footing as `electron/services/brain/links.ts` / `src/lib/brainWikilinks.ts`.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `electron/services/brain/sources/types.ts` | `BrainSource`, `SourceItem`, `AdmitVerdict`, `DistilledItem`, `SessionMetadata`. No logic. |
| `electron/services/brain/sources/state.ts` | `brain_sources` read/write and mtime-then-sha256 change detection. The only file that knows the table's columns. |
| `electron/services/brain/sources/session-transcripts.ts` | The session adapter: `discover()`, `admit()`, `distill()`. The only file that touches `<config_dir>/projects/`. |
| `electron/services/brain/distill.ts` | Pure JSONL-text → prose + metadata. No I/O, no account awareness, no model. |
| `src/components/brain/BrainSources.tsx` | The Sources pane: discovered items, verdicts, distilled preview. |
| `electron/__tests__/brain-source-state.test.ts` | Change detection and status round-trips. |
| `electron/__tests__/brain-distill.test.ts` | The heavily-tested pure core. |
| `electron/__tests__/brain-session-source.test.ts` | Discovery, ownership, exclusions, the admission gate, and the two-account isolation property. |
| `electron/__tests__/fixtures/brain/*.jsonl` | Redacted real transcripts. |
| `src/components/__tests__/BrainSources.test.tsx` | Pane rendering and account scoping. |

**Modified:** `electron/services/brain/registry.ts` (Task 1 + Task 7), `electron/ipc/brain-handlers.ts`, `electron/ipc/channels.ts`, `electron/main.ts`, `src/lib/api.ts`, `src/components/brain/BrainTab.tsx`, `electron/__tests__/brain-registry.test.ts`, `electron/__tests__/brain-ipc.test.ts`, `docs/superpowers/plans/2026-08-11-brain-vault-followups.md`.

## Deliberate Deviations From The Spec

Both are deviations a reviewer should check on purpose, not accidents:

1. **`admit()` returns `AdmitVerdict`, not `boolean`.** Spec §5 types it `admit(item): boolean`. A bare boolean cannot tell the Sources pane *why* a session was skipped, and "eyeball the gate before spending tokens" is the entire justification for this step existing. The verdict carries the reason string; the gate stays exactly as deterministic as specified.
2. **`discover()` returns items across all accounts in one call**, each stamped with its owning `accountId`. Spec §5 shows a per-adapter `discover()` with no account parameter and §4 says every adapter "reports an owning account for each item" — this is that, made explicit. Taking an `accountId` parameter would invert the ownership rule: the caller would be asserting ownership rather than the item's location deriving it.

---

### Task 1: Thread an injectable `ExecGit` through `createBrainService`

Carried over from the Plan 1 review (`docs/superpowers/plans/2026-08-11-brain-vault-followups.md`). `createVaultGit(root, exec)` already accepts an injectable exec, but `registry.ts`'s only call site passes none and `createBrainService` has no parameter to forward one. `open()` therefore fires a real `git init` child process fire-and-forget, and tests race it during cleanup — `brain-ipc.test.ts:47-61` and `brain-registry.test.ts` both carry a retry-and-swallow `afterEach` naming this exact fix. Plan 3 calls `open()` far more often, so the race gets worse if this is left alone.

**Files:**
- Modify: `electron/services/brain/registry.ts` (imports at :12, `VaultHandle` at :66-72, `createBrainService` signature at :250, git construction at :449-451)
- Modify: `electron/__tests__/brain-registry.test.ts` (`afterEach`)
- Modify: `electron/__tests__/brain-ipc.test.ts` (`afterEach` at :47-61)

**Interfaces:**
- Consumes: `ExecGit`, `createVaultGit` from `electron/services/brain/git.ts` (already exported).
- Produces:
  - `createBrainService(db: Database, opts?: { execGit?: ExecGit }): BrainService`
  - `VaultHandle.gitReady: Promise<void>` — resolves when this handle's `git init` has finished (or failed harmlessly). Never rejects.

- [ ] **Step 1: Write the failing test**

Add to `electron/__tests__/brain-registry.test.ts`:

```ts
it('routes vault git through an injected exec and exposes an awaitable init', async () => {
  const calls: { args: string[]; cwd: string }[] = [];
  const execGit = async (args: string[], cwd: string) => {
    calls.push({ args, cwd });
    return '';
  };
  const svc = createBrainService(db, { execGit });
  svc.setVaultPath(accountId, join(dir, 'vault'));

  const handle = svc.open(accountId);
  expect(handle).not.toBeNull();

  // The point of the promise: after awaiting it, no git work is still in
  // flight, so a caller (or a test's afterEach) can delete the directory
  // without racing an untracked child process.
  await handle!.gitReady;
  expect(calls).toEqual([{ args: ['init', '-q'], cwd: handle!.root }]);

  svc.closeAll();
});

it('never rejects gitReady when git is unavailable', async () => {
  const svc = createBrainService(db, {
    execGit: async () => { throw new Error('git: command not found'); },
  });
  svc.setVaultPath(accountId, join(dir, 'vault'));
  const handle = svc.open(accountId);
  // Versioning is a safety net, not a dependency: a missing binary must not
  // turn into an unhandled rejection at every call site that awaits this.
  await expect(handle!.gitReady).resolves.toBeUndefined();
  svc.closeAll();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/brain-registry.test.ts -t 'injected exec'`
Expected: FAIL — `createBrainService` takes one argument, and `handle.gitReady` is `undefined` so `await` resolves without the assertion on `calls` ever passing.

- [ ] **Step 3: Write the implementation**

In `electron/services/brain/registry.ts`, extend the import at line 12:

```ts
import { createVaultGit, type ExecGit, type VaultGit } from './git';
```

Add to `VaultHandle` (after `readonly git: VaultGit;` at line 71):

```ts
  /**
   * Resolves when this handle's `git init` has settled — successfully or not.
   *
   * `open()` cannot await it: opening a vault must stay synchronous, and
   * versioning is auxiliary anyway. But an untracked child process still
   * writing into `.git` is observable to anyone who deletes the vault
   * directory afterwards (test cleanup hit exactly this, as ENOTEMPTY under
   * full-suite load). Exposing the promise makes the init joinable by anyone
   * who needs it to be, without making anyone wait who does not.
   *
   * Never rejects: `git.init()` already swallows a missing binary, and a
   * rejection here would surface as an unhandled rejection in every call site
   * that stores the handle without awaiting.
   */
  readonly gitReady: Promise<void>;
```

Change the factory signature at line 250:

```ts
export interface BrainServiceOptions {
  /**
   * Git runner for every vault this service opens. Production passes nothing
   * and gets the real `git` binary. Tests pass a stub so no child process is
   * spawned — which is what makes vault cleanup deterministic rather than a
   * race against an untracked `git init`.
   */
  execGit?: ExecGit;
}

export function createBrainService(db: Database, opts: BrainServiceOptions = {}): BrainService {
```

Replace lines 449-451 with:

```ts
      const git = createVaultGit(vault.root, opts.execGit);
      // Versioning is a safety net; a missing git binary must not block a write.
      // The promise is retained on the handle rather than dropped, so callers
      // that must not race the init (test cleanup, and any future indexer that
      // commits immediately after opening) can join it.
      const gitReady = git.init().catch((err: unknown) => {
        console.warn('brain: git init failed:', err);
      });
```

Add `gitReady` to the handle literal at line 455:

```ts
      const handle: VaultHandle = { accountId, root: vault.root, vault, index, git, gitReady };
```

`fireAndLogGitFailure` is still used by `writeNote`, so its import stays.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run electron/__tests__/brain-registry.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Delete the cleanup workarounds both test files carry**

In `electron/__tests__/brain-ipc.test.ts`, construct the service with a stub exec in `beforeEach`:

```ts
  // A stub git runner: no child process, so nothing is still writing into
  // `.git` when afterEach removes the directory. This is what replaced the
  // retry-and-swallow rmSync that used to live below.
  brain = createBrainService(db, { execGit: async () => '' });
```

and reduce the `afterEach` to the plain form:

```ts
  afterEach(() => {
    brain.closeAll();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
```

Apply the identical change in `electron/__tests__/brain-registry.test.ts`, except in the two tests written above, which pass their own `execGit`.

- [ ] **Step 6: Run the full backend suite**

Run: `npm test`
Expected: PASS — 240+ files. Watch specifically for `brain-ipc.test.ts`: it must pass without the retry, which is the proof the race is gone rather than merely re-hidden.

- [ ] **Step 7: Commit**

```bash
git add electron/services/brain/registry.ts electron/__tests__/brain-registry.test.ts electron/__tests__/brain-ipc.test.ts
git commit -m "refactor(brain): thread injectable ExecGit through createBrainService

git init was fired and forgotten, so vault cleanup raced an untracked
child process — ENOTEMPTY on .git under full-suite load. The handle now
carries an awaitable gitReady and tests inject a stub exec, which deletes
the retry-and-swallow afterEach both brain test files carried.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Source types and the `brain_sources` state store

`brain_sources` already exists (schema v18, `BRAIN_TABLES_DDL` at `electron/services/database.ts:60-72`). Nothing reads or writes it yet. This task gives it an owner.

**Files:**
- Create: `electron/services/brain/sources/types.ts`
- Create: `electron/services/brain/sources/state.ts`
- Test: `electron/__tests__/brain-source-state.test.ts`

**Interfaces:**
- Consumes: `Database` from `electron/services/database.ts` (`db.raw` is the `better-sqlite3` handle — see `accounts.ts:274`).
- Produces: everything in `types.ts` below, plus `createSourceStateStore(db: Database): SourceStateStore`.

- [ ] **Step 1: Write `sources/types.ts`** (no test — pure type declarations, exercised by every later task)

```ts
/**
 * Shared vocabulary for Brain source adapters.
 *
 * A "source" is anything that can produce indexable material: session
 * transcripts, repo artifacts, auto-memory notes, explicit captures. All of
 * them implement `BrainSource` so that adding one changes nothing upstream
 * (spec §5).
 */

/**
 * One candidate for indexing, with a key that is stable across restarts.
 *
 * `accountId` is derived from WHERE the item lives, never from `resolve()` and
 * never from a caller-supplied default — see spec §4. An adapter that cannot
 * determine ownership must omit the item rather than guess; guessing writes
 * one account's material into another account's vault, which is the
 * confidentiality failure this whole design exists to prevent.
 */
export interface SourceItem {
  /** The adapter that produced this. Matches `BrainSource.id`. */
  sourceId: string;
  /** Unique within (accountId, sourceId). For sessions: the session id. */
  itemKey: string;
  /** The owning account. */
  accountId: number;
  /** Absolute path to the backing file. */
  path: string;
  /** Modification time in epoch ms, from `fs.stat`. */
  mtimeMs: number;
  /** Size in bytes. Half of the cheap change check. */
  size: number;
  /** Short human label for the Sources pane, e.g. the project directory. */
  label: string;
}

/**
 * Why an item was admitted or skipped.
 *
 * Spec §5 types `admit()` as returning a bare boolean. It returns this
 * instead: the reason is what the Sources pane displays, and "inspect the
 * gate's decisions before spending tokens" is the stated purpose of this
 * build step. The gate itself is unchanged — still deterministic, still no
 * model.
 */
export interface AdmitVerdict {
  admitted: boolean;
  /** Populated in both directions. Never empty. */
  reason: string;
}

/**
 * Deterministic facts about a session, extracted with NO model (spec §6).
 * The model's job is prose and aliases; everything here is read straight off
 * the transcript rows.
 */
export interface SessionMetadata {
  sessionId: string;
  /** The `cwd` the session ran in. Null when no row carries one. */
  projectPath: string | null;
  gitBranch: string | null;
  /** Distinct models, in first-seen order. A session can switch mid-run. */
  models: string[];
  cliVersion: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  /** User prompts — the turn anchor, per spec §6. */
  promptCount: number;
  /** Assistant messages carrying prose (not tool_use, not thinking). */
  proseCount: number;
  /**
   * Absolute paths named by file-touching tool calls, deduped, in first-seen
   * order. Paths only — file CONTENTS never appear anywhere in a distillation.
   */
  filesTouched: string[];
  terminalStatus: 'completed' | 'error' | 'unknown';
}

/** The bounded prose plus structured metadata handed to Plan 4's extractor. */
export interface DistilledItem {
  /** Bounded prose. Never contains tool results, file contents or diffs. */
  prose: string;
  metadata: SessionMetadata;
  /** True when the ceiling forced oldest-first truncation. */
  truncated: boolean;
}

/**
 * A source of indexable material. All three methods are independently
 * testable, and GitHub/Jira adapters later implement this same interface with
 * nothing upstream changing (spec §5).
 */
export interface BrainSource {
  readonly id: string;
  /**
   * Every candidate across every account, each stamped with its owning
   * account. There is deliberately no `accountId` parameter: ownership is a
   * property of where an item lives, so a caller that could pass one would be
   * asserting ownership rather than deriving it.
   */
  discover(): Promise<SourceItem[]>;
  admit(item: SourceItem): AdmitVerdict;
  distill(item: SourceItem): Promise<DistilledItem>;
}
```

- [ ] **Step 2: Write the failing test for the state store**

Create `electron/__tests__/brain-source-state.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createSourceStateStore, type SourceStateStore } from '../services/brain/sources/state';
import type { SourceItem } from '../services/brain/sources/types';

describe('brain source state', () => {
  let db: Database;
  let store: SourceStateStore;
  let dir: string;
  let accountId: number;

  function item(overrides: Partial<SourceItem> = {}): SourceItem {
    return {
      sourceId: 'session',
      itemKey: 'sess-1',
      accountId,
      path: join(dir, 'sess-1.jsonl'),
      mtimeMs: 1_000,
      size: 42,
      label: 'omnifex',
      ...overrides,
    };
  }

  beforeEach(() => {
    db = createDatabase(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'brain-src-'));
    const info = db.raw
      .prepare("INSERT INTO accounts (name, config_dir, engine, subscription_label, has_cost) VALUES ('personal', ?, 'claude', 'Max', 0)")
      .run(join(dir, 'cfg'));
    accountId = Number(info.lastInsertRowid);
    store = createSourceStateStore(db);
    writeFileSync(item().path, 'hello', 'utf-8');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('treats an item it has never seen as changed', () => {
    expect(store.hasChanged(item())).toBe(true);
  });

  it('treats an unmodified item as unchanged after recording it', () => {
    store.record(item(), { status: 'indexed' });
    expect(store.hasChanged(item())).toBe(false);
  });

  it('rehashes when mtime moves and reports unchanged if the bytes are identical', () => {
    store.record(item(), { status: 'indexed' });
    // A touch without an edit: mtime moved, content did not. The sha256 check
    // is what stops this from re-indexing the whole vault after a backup
    // restore or a checkout that rewrites timestamps.
    expect(store.hasChanged(item({ mtimeMs: 9_999 }))).toBe(false);
  });

  it('reports changed when the bytes differ', () => {
    store.record(item(), { status: 'indexed' });
    writeFileSync(item().path, 'hello world', 'utf-8');
    expect(store.hasChanged(item({ mtimeMs: 9_999, size: 11 }))).toBe(true);
  });

  it('scopes state by account: the same item key under another account is unseen', () => {
    const other = Number(
      db.raw
        .prepare("INSERT INTO accounts (name, config_dir, engine, subscription_label, has_cost) VALUES ('work', ?, 'claude', 'Max', 0)")
        .run(join(dir, 'cfg-work')).lastInsertRowid,
    );
    store.record(item(), { status: 'indexed' });
    expect(store.hasChanged(item({ accountId: other }))).toBe(true);
  });

  it('round-trips status and error, and lists only one account at a time', () => {
    store.record(item(), { status: 'failed', error: 'zod: entities required' });
    const rows = store.list(accountId, 'session');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toBe('zod: entities required');
  });

  it('upserts rather than duplicating on re-record', () => {
    store.record(item(), { status: 'pending' });
    store.record(item(), { status: 'indexed' });
    const rows = store.list(accountId, 'session');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('indexed');
    // A successful record clears a stale error, or the Sources pane keeps
    // showing a failure that has since been fixed.
    expect(rows[0].error).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run electron/__tests__/brain-source-state.test.ts`
Expected: FAIL — `Cannot find module '../services/brain/sources/state'`.

- [ ] **Step 4: Write `sources/state.ts`**

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Database } from '../../database';
import type { SourceItem } from './types';

/**
 * Where an item stands with the indexer.
 *
 * `blocked` is distinct from `failed` on purpose: failed means the pipeline
 * tried and something went wrong, blocked means it was never eligible (no
 * owning account, per spec §4's "no silent default-account fallback"). They
 * need different remedies, so they cannot share a status.
 */
export type SourceStatus = 'pending' | 'indexed' | 'skipped' | 'failed' | 'blocked';

export interface SourceState {
  accountId: number;
  sourceId: string;
  itemKey: string;
  mtime: number | null;
  hash: string | null;
  lastIndexedAt: string | null;
  status: SourceStatus;
  error: string | null;
}

export interface RecordOptions {
  status: SourceStatus;
  /** Cleared when omitted — see the upsert test. */
  error?: string;
}

export interface SourceStateStore {
  get(accountId: number, sourceId: string, itemKey: string): SourceState | null;
  list(accountId: number, sourceId: string): SourceState[];
  /** Upsert. Stamps mtime and a fresh content hash from the item's file. */
  record(item: SourceItem, opts: RecordOptions): void;
  /** Rowboat's hybrid: mtime first, sha256 only when mtime disagrees. */
  hasChanged(item: SourceItem): boolean;
}

interface Row {
  account_id: number;
  source_id: string;
  item_key: string;
  mtime: number | null;
  hash: string | null;
  last_indexed_at: string | null;
  status: string;
  error: string | null;
}

function toState(row: Row): SourceState {
  return {
    accountId: row.account_id,
    sourceId: row.source_id,
    itemKey: row.item_key,
    mtime: row.mtime,
    hash: row.hash,
    lastIndexedAt: row.last_indexed_at,
    status: row.status as SourceStatus,
    error: row.error,
  };
}

/**
 * sha256 of the file's bytes, or null when it cannot be read.
 *
 * Null is treated as "changed" by every caller. A file that vanished between
 * discovery and hashing is exactly the case where re-examining it is correct.
 */
function hashFile(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Change detection and status for every source adapter.
 *
 * State lives in SQLite rather than Rowboat's `knowledge_graph_state.json`
 * (spec §5): the DB, its migrations and the `createDatabase(':memory:')` test
 * harness already exist, and a JSON blob rewritten per item is a corruption
 * risk their design simply accepts.
 *
 * Note content NEVER lives here — only pointers and status (spec §4).
 */
export function createSourceStateStore(db: Database): SourceStateStore {
  const raw = db.raw;

  function get(accountId: number, sourceId: string, itemKey: string): SourceState | null {
    const row = raw
      .prepare(
        'SELECT * FROM brain_sources WHERE account_id = ? AND source_id = ? AND item_key = ?',
      )
      .get(accountId, sourceId, itemKey) as Row | undefined;
    return row ? toState(row) : null;
  }

  function list(accountId: number, sourceId: string): SourceState[] {
    const rows = raw
      .prepare(
        'SELECT * FROM brain_sources WHERE account_id = ? AND source_id = ? ORDER BY item_key',
      )
      .all(accountId, sourceId) as Row[];
    return rows.map(toState);
  }

  function record(item: SourceItem, opts: RecordOptions): void {
    raw
      .prepare(
        `INSERT INTO brain_sources
           (account_id, source_id, item_key, mtime, hash, last_indexed_at, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, source_id, item_key) DO UPDATE SET
           mtime = excluded.mtime,
           hash = excluded.hash,
           last_indexed_at = excluded.last_indexed_at,
           status = excluded.status,
           error = excluded.error`,
      )
      .run(
        item.accountId,
        item.sourceId,
        item.itemKey,
        Math.floor(item.mtimeMs),
        hashFile(item.path),
        new Date().toISOString(),
        opts.status,
        opts.error ?? null,
      );
  }

  function hasChanged(item: SourceItem): boolean {
    const prior = get(item.accountId, item.sourceId, item.itemKey);
    if (!prior) return true;
    // Fast path: an untouched mtime means untouched bytes on every filesystem
    // this app runs on, and it costs one integer compare instead of a full
    // file read.
    if (prior.mtime === Math.floor(item.mtimeMs)) return false;
    // Slow path. mtime moving does NOT imply the content moved — a restore, a
    // branch switch, or a `touch` all rewrite timestamps over identical bytes,
    // and treating those as edits would re-index an entire vault for nothing.
    const current = hashFile(item.path);
    if (current === null || prior.hash === null) return true;
    return current !== prior.hash;
  }

  return { get, list, record, hasChanged };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run electron/__tests__/brain-source-state.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add electron/services/brain/sources electron/__tests__/brain-source-state.test.ts
git commit -m "feat(brain): source adapter types and brain_sources state store

Gives the schema-v18 brain_sources table its first owner: per-account
change detection using Rowboat's mtime-then-sha256 hybrid, so a restore or
a branch switch that rewrites timestamps does not re-index everything.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `distill.ts` — transcript rows to bounded prose

The pure core, and the file the spec singles out for the heaviest testing (§Testing). No I/O, no account awareness, no model.

**Files:**
- Create: `electron/services/brain/distill.ts`
- Create: `electron/__tests__/fixtures/brain/session-normal.jsonl`
- Test: `electron/__tests__/brain-distill.test.ts`

**Interfaces:**
- Consumes: `SessionMetadata`, `DistilledItem` from `./sources/types`.
- Produces:
  - `parseTranscriptRows(jsonl: string): TranscriptRow[]`
  - `isPromptRow(row: Record<string, unknown>): boolean`
  - `distillTranscript(jsonl: string, sessionId: string): DistilledItem`
  - `DISTILL_MAX_CHARS: 8_192`

- [ ] **Step 1: Build the fixture**

Create `electron/__tests__/fixtures/brain/session-normal.jsonl`. Every line is one JSON object; field names match real CLI output (verified against CLI 2.1.228 transcripts). Keep it literal — the point of a fixture is that it is not generated by the code under test.

```jsonl
{"type":"user","uuid":"u1","sessionId":"sess-normal","timestamp":"2026-08-01T10:00:00.000Z","cwd":"/Users/dev/Repos/omnifex","gitBranch":"main","version":"2.1.228","promptSource":"user","message":{"role":"user","content":"Add a status probe to the vault registry"}}
{"type":"assistant","uuid":"a1","sessionId":"sess-normal","timestamp":"2026-08-01T10:00:04.000Z","cwd":"/Users/dev/Repos/omnifex","gitBranch":"main","version":"2.1.228","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"thinking","thinking":"The user wants a non-creating probe. Let me look at registry.ts."}]}}
{"type":"assistant","uuid":"a2","sessionId":"sess-normal","timestamp":"2026-08-01T10:00:06.000Z","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/Users/dev/Repos/omnifex/electron/services/brain/registry.ts"}}]}}
{"type":"user","uuid":"u2","sessionId":"sess-normal","timestamp":"2026-08-01T10:00:07.000Z","sourceToolAssistantUUID":"a2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"export function createBrainService(db: Database): BrainService { ... 600 lines of source ... }"}]}}
{"type":"assistant","uuid":"a3","sessionId":"sess-normal","timestamp":"2026-08-01T10:00:20.000Z","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"`open()` lazily scaffolds the layout, so it cannot answer \"does this vault exist?\". I'll add a separate probe that only ever looks."}]}}
{"type":"assistant","uuid":"a4","sessionId":"sess-normal","timestamp":"2026-08-01T10:00:25.000Z","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"/Users/dev/Repos/omnifex/electron/services/brain/registry.ts","old_string":"foo","new_string":"bar"}}]}}
{"type":"user","uuid":"u3","sessionId":"sess-normal","timestamp":"2026-08-01T10:00:26.000Z","sourceToolAssistantUUID":"a4","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"The file has been updated."}]}}
{"type":"user","uuid":"u4","sessionId":"sess-normal","timestamp":"2026-08-01T10:01:00.000Z","isMeta":true,"message":{"role":"user","content":"<command-name>/verify</command-name>"}}
{"type":"user","uuid":"u5","sessionId":"sess-normal","timestamp":"2026-08-01T10:02:00.000Z","cwd":"/Users/dev/Repos/omnifex","gitBranch":"main","promptSource":"user","message":{"role":"user","content":"Now write the tests for it"}}
{"type":"assistant","uuid":"a5","sessionId":"sess-normal","timestamp":"2026-08-01T10:02:30.000Z","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"Added seven cases covering never-configured, configured-but-missing, and the conflict path."}]}}
```

- [ ] **Step 2: Write the failing test**

Create `electron/__tests__/brain-distill.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { distillTranscript, DISTILL_MAX_CHARS } from '../services/brain/distill';

const FIXTURES = join(__dirname, 'fixtures', 'brain');
const normal = readFileSync(join(FIXTURES, 'session-normal.jsonl'), 'utf-8');

describe('distillTranscript', () => {
  it('keeps prompts and assistant prose', () => {
    const { prose } = distillTranscript(normal, 'sess-normal');
    expect(prose).toContain('Add a status probe to the vault registry');
    expect(prose).toContain('Now write the tests for it');
    expect(prose).toContain('it cannot answer "does this vault exist?"');
    expect(prose).toContain('Added seven cases covering never-configured');
  });

  it('never lets a tool result or file content reach the output', () => {
    const { prose } = distillTranscript(normal, 'sess-normal');
    // The single most important assertion in this file: spec §6's "the model
    // must never see raw JSONL" is what keeps whole source files, diffs and
    // command output out of a note that later gets read back into a prompt.
    expect(prose).not.toContain('600 lines of source');
    expect(prose).not.toContain('The file has been updated');
    expect(prose).not.toContain('tool_result');
    expect(prose).not.toContain('old_string');
  });

  it('drops thinking blocks', () => {
    const { prose } = distillTranscript(normal, 'sess-normal');
    expect(prose).not.toContain('Let me look at registry.ts');
  });

  it('drops meta rows and slash-command wrappers', () => {
    const { prose } = distillTranscript(normal, 'sess-normal');
    expect(prose).not.toContain('<command-name>');
    expect(prose).not.toContain('/verify');
  });

  it('anchors turn counting on prompts, not assistant adjacency', () => {
    const { metadata } = distillTranscript(normal, 'sess-normal');
    // Two real prompts. Five assistant rows and three tool-result user rows
    // sit between them; an adjacency-based count would say something else,
    // which is the exact miscount turnDelta.ts documents.
    expect(metadata.promptCount).toBe(2);
    expect(metadata.proseCount).toBe(2);
  });

  it('extracts deterministic metadata with no model', () => {
    const { metadata } = distillTranscript(normal, 'sess-normal');
    expect(metadata.sessionId).toBe('sess-normal');
    expect(metadata.projectPath).toBe('/Users/dev/Repos/omnifex');
    expect(metadata.gitBranch).toBe('main');
    expect(metadata.models).toEqual(['claude-opus-5']);
    expect(metadata.cliVersion).toBe('2.1.228');
    expect(metadata.startedAt).toBe('2026-08-01T10:00:00.000Z');
    expect(metadata.endedAt).toBe('2026-08-01T10:02:30.000Z');
    expect(metadata.durationMs).toBe(150_000);
    expect(metadata.terminalStatus).toBe('completed');
  });

  it('records file PATHS touched, never their contents', () => {
    const { metadata } = distillTranscript(normal, 'sess-normal');
    expect(metadata.filesTouched).toEqual([
      '/Users/dev/Repos/omnifex/electron/services/brain/registry.ts',
    ]);
  });

  it('truncates oldest-first with an explicit marker', () => {
    const filler = 'x'.repeat(2_000);
    const rows: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      rows.push(JSON.stringify({
        type: 'user', uuid: `u${i}`, sessionId: 's', timestamp: '2026-08-01T10:00:00.000Z',
        message: { role: 'user', content: `PROMPT-${i} ${filler}` },
      }));
    }
    const { prose, truncated } = distillTranscript(rows.join('\n'), 's');

    expect(truncated).toBe(true);
    expect(prose.length).toBeLessThanOrEqual(DISTILL_MAX_CHARS);
    // Oldest-first: the tail survives, the head is dropped. A reader that
    // cannot tell it is holding a tail will narrate the session as if it
    // started in the middle.
    expect(prose).toContain('PROMPT-11');
    expect(prose).not.toContain('PROMPT-0 ');
    expect(prose).toContain('earlier turns elided');
  });

  it('does not mark a transcript under the ceiling as truncated', () => {
    const { truncated, prose } = distillTranscript(normal, 'sess-normal');
    expect(truncated).toBe(false);
    expect(prose).not.toContain('elided');
  });

  it('survives malformed lines without throwing', () => {
    const broken = `not json\n${normal}\n{"unterminated":`;
    expect(() => distillTranscript(broken, 'sess-normal')).not.toThrow();
    expect(distillTranscript(broken, 'sess-normal').metadata.promptCount).toBe(2);
  });

  it('returns empty prose and zero counts for an empty transcript', () => {
    const { prose, metadata, truncated } = distillTranscript('', 'sess-empty');
    expect(prose).toBe('');
    expect(metadata.promptCount).toBe(0);
    expect(metadata.terminalStatus).toBe('unknown');
    expect(truncated).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run electron/__tests__/brain-distill.test.ts`
Expected: FAIL — `Cannot find module '../services/brain/distill'`.

- [ ] **Step 4: Write `distill.ts`**

```ts
import type { DistilledItem, SessionMetadata } from './sources/types';

/**
 * JSONL transcript → bounded prose plus structured metadata.
 *
 * Pure: text in, values out. No filesystem, no account awareness, no model.
 * That is what makes the spec's heaviest test requirements cheap to satisfy.
 *
 * Two rules govern everything here, both from spec §6:
 *
 *   1. The model must never see raw JSONL. Prompts, assistant prose and
 *      outcomes are kept; tool results, file contents, diffs, thinking and
 *      attachments are dropped ENTIRELY — not summarised, not truncated.
 *      A note built from this text can be read back into a future prompt, so
 *      anything that leaks in here leaks twice.
 *   2. Turns anchor on the user PROMPT, never on assistant-message adjacency,
 *      which miscounts any turn containing subagents. Same rule, same reason
 *      as `src/lib/turnDelta.ts`.
 *
 * Why this does not import the renderer's classifier: `src/lib/jsonlClassifier.ts`
 * is the authoritative version of the prompt rule, but it imports `@/types/jsonl`
 * and `tsconfig.electron.json` defines no `paths` alias, so importing it fails
 * `npm run check`. `isPromptRow` below is its narrow twin, in the same
 * across-the-process-boundary arrangement as `electron/services/brain/links.ts`
 * and `src/lib/brainWikilinks.ts`. If the CLI changes how a prompt row is
 * marked, BOTH need updating.
 */

/**
 * ~8KB per session (spec §6). Characters rather than tokens: the ceiling is a
 * budget guard, and a tokenizer here would be precision nobody consumes.
 */
export const DISTILL_MAX_CHARS = 8_192;

const TRUNCATION_MARKER = '[… earlier turns elided …]\n\n';

/** Tools whose `input.file_path` names a file the session touched. */
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

type Row = Record<string, unknown>;

function asRecord(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Parse leniently: a malformed line is skipped, never thrown. */
function parseRows(jsonl: string): Row[] {
  const rows: Row[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const row = asRecord(parsed);
      if (row) rows.push(row);
    } catch {
      // A truncated final line is normal for a session still being written.
    }
  }
  return rows;
}

/**
 * True for a row that is a HUMAN prompt.
 *
 * The exclusions are all rows the CLI also types as `user`:
 *  - tool results (they ride on user-type rows with an array content whose
 *    only blocks are `tool_result`)
 *  - `isMeta` rows: skill injections, attachment markers, slash-command
 *    preludes — machine text the user never typed
 *  - compaction summaries (`isCompactSummary`, or `isReplay === false`),
 *    which are the CLI replaying its own text back into the transcript
 *  - sidechain rows, which belong to a subagent's conversation, not the
 *    user's
 */
export function isPromptRow(row: Row): boolean {
  if (row.type !== 'user') return false;
  if (row.isMeta === true) return false;
  if (row.isSidechain === true) return false;
  if (row.isCompactSummary === true) return false;
  // Strict `=== false`: a live prompt omits isReplay entirely, and `undefined`
  // must not read as "not a replay, therefore a summary".
  if (row.isReplay === false) return false;
  return promptText(row) !== null;
}

/** The typed text of a prompt row, or null when the row carries none. */
function promptText(row: Row): string | null {
  const message = asRecord(row.message);
  if (!message) return null;
  const content = message.content;

  if (typeof content === 'string') return cleanPrompt(content);

  if (Array.isArray(content)) {
    // Any `tool_result` block disqualifies the row: that is tool output
    // wearing a user-row costume, and it is exactly the bulk this function
    // exists to keep out.
    if (content.some((b) => asRecord(b)?.type === 'tool_result')) return null;
    const text = content
      .map((b) => asRecord(b))
      .filter((b): b is Row => b !== null && b.type === 'text')
      .map((b) => asString(b.text))
      .filter((t): t is string => t !== null)
      .join('\n');
    return cleanPrompt(text);
  }

  return null;
}

/**
 * Drop the slash-command wrapper tags the CLI injects around a prelude
 * (`<command-name>`, `<command-stdout>`, …). Matching `sessions-summary.ts`'s
 * filter: these are machine text, and a note quoting them reads as if the user
 * typed XML.
 */
function cleanPrompt(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^<command-(name|stdout|args|message)>/.test(trimmed)) return null;
  return trimmed;
}

/** Assistant PROSE only — no tool_use, no thinking, no redacted blocks. */
function assistantProse(row: Row): string | null {
  if (row.type !== 'assistant') return null;
  if (row.isSidechain === true) return null;
  const message = asRecord(row.message);
  if (!message || !Array.isArray(message.content)) return null;
  const text = message.content
    .map((b) => asRecord(b))
    .filter((b): b is Row => b !== null && b.type === 'text')
    .map((b) => asString(b.text))
    .filter((t): t is string => t !== null)
    .join('\n')
    .trim();
  return text.length > 0 ? text : null;
}

function collectMetadata(rows: Row[], sessionId: string): SessionMetadata {
  let projectPath: string | null = null;
  let gitBranch: string | null = null;
  let cliVersion: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let promptCount = 0;
  let proseCount = 0;
  let sawApiError = false;
  const models: string[] = [];
  const filesTouched: string[] = [];

  for (const row of rows) {
    const ts = asString(row.timestamp);
    if (ts) {
      if (!startedAt) startedAt = ts;
      endedAt = ts;
    }
    // First-seen wins for the session-wide facts: the CLI stamps these on
    // most rows, and a session that changed directory mid-run is still the
    // session that STARTED where it started.
    projectPath ??= asString(row.cwd);
    gitBranch ??= asString(row.gitBranch);
    cliVersion ??= asString(row.version);

    if (row.isApiErrorMessage === true) sawApiError = true;
    if (isPromptRow(row)) promptCount += 1;
    if (assistantProse(row) !== null) proseCount += 1;

    const message = asRecord(row.message);
    const model = message ? asString(message.model) : null;
    if (model && !models.includes(model)) models.push(model);

    if (message && Array.isArray(message.content)) {
      for (const block of message.content) {
        const b = asRecord(block);
        if (!b || b.type !== 'tool_use') continue;
        const name = asString(b.name);
        if (!name || !FILE_TOOLS.has(name)) continue;
        const input = asRecord(b.input);
        const filePath = input ? asString(input.file_path) : null;
        // The PATH, never the input's `content` / `new_string`. A file body
        // reaching a note is the same leak as a tool result reaching prose.
        if (filePath && !filesTouched.includes(filePath)) filesTouched.push(filePath);
      }
    }
  }

  const durationMs =
    startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : null;

  return {
    sessionId,
    projectPath,
    gitBranch,
    models,
    cliVersion,
    startedAt,
    endedAt,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    promptCount,
    proseCount,
    filesTouched,
    terminalStatus: rows.length === 0 ? 'unknown' : sawApiError ? 'error' : 'completed',
  };
}

/**
 * Trim to the ceiling by dropping the OLDEST turns, marking what happened.
 *
 * Oldest-first rather than head+tail (which is what `sessions-summary.ts`
 * does for a different contract): a session's conclusions live at its end,
 * and those are what a memory note is for. The marker is not decoration —
 * a reader with no marker narrates a tail as if it were the whole session.
 */
function truncateOldestFirst(chunks: string[]): { prose: string; truncated: boolean } {
  const joined = chunks.join('\n\n');
  if (joined.length <= DISTILL_MAX_CHARS) return { prose: joined, truncated: false };

  const budget = DISTILL_MAX_CHARS - TRUNCATION_MARKER.length;
  const kept: string[] = [];
  let used = 0;
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const cost = chunks[i].length + (kept.length > 0 ? 2 : 0);
    if (used + cost > budget) break;
    kept.unshift(chunks[i]);
    used += cost;
  }
  // A single chunk larger than the whole budget still has to yield something,
  // or a session with one enormous prompt distills to nothing but a marker.
  if (kept.length === 0) kept.push(chunks[chunks.length - 1].slice(-budget));
  return { prose: TRUNCATION_MARKER + kept.join('\n\n'), truncated: true };
}

/**
 * Reduce one session transcript to what a model may see.
 *
 * `sessionId` is passed in rather than read from the rows: the file's name is
 * the authority on which session it is, and a transcript whose rows disagree
 * with its filename should not get to rename itself.
 */
export function distillTranscript(jsonl: string, sessionId: string): DistilledItem {
  const rows = parseRows(jsonl);
  const chunks: string[] = [];

  for (const row of rows) {
    const prompt = isPromptRow(row) ? promptText(row) : null;
    if (prompt) {
      chunks.push(`USER: ${prompt}`);
      continue;
    }
    const prose = assistantProse(row);
    if (prose) chunks.push(`ASSISTANT: ${prose}`);
  }

  const { prose, truncated } = truncateOldestFirst(chunks);
  return { prose, metadata: collectMetadata(rows, sessionId), truncated };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run electron/__tests__/brain-distill.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add electron/services/brain/distill.ts electron/__tests__/brain-distill.test.ts electron/__tests__/fixtures/brain
git commit -m "feat(brain): distill session transcripts to bounded prose

Pure JSONL-text to prompts, assistant prose and structured metadata under
an 8KB ceiling, truncating oldest-first with an explicit marker. Tool
results, file contents, diffs and thinking are dropped entirely: a note
built from this text gets read back into a future prompt, so anything
that leaks here leaks twice.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `discover()` — find every session transcript and who owns it

**Files:**
- Create: `electron/services/brain/sources/session-transcripts.ts`
- Test: `electron/__tests__/brain-session-source.test.ts`

**Interfaces:**
- Consumes: `SourceItem`, `BrainSource` from `./types`; `AccountsService` from `electron/services/accounts.ts` (`listAccounts()`, `getAccountByConfigDir()` at `accounts.ts:283`); `SCRATCH_DIR_NAME` — see Step 3 for why it is re-exported.
- Produces: `createSessionSource(deps: SessionSourceDeps): BrainSource` with `id = 'session'`.

Two exclusions are load-bearing and were both found by reading a real config dir, not by inference:

1. **OmniFex's own summary scratch transcripts.** `sessions/summary-query.ts` pins every summary run to `<os.tmpdir()>/omnifex-summary-scratch`, which the CLI encodes into a real `projects/<encoded>/` directory full of one-shot JSONL. A live personal config dir has these sitting alongside genuine projects. Indexing them would fill the Brain with OmniFex talking to itself.
2. **Session sidecar directories.** A project directory contains `<sessionId>.jsonl` files *and* `<sessionId>/` directories holding `subagents/` and `tool-results/`. Discovery takes only the top-level `.jsonl` files; a recursive walk would ingest subagent transcripts as if they were user sessions.

- [ ] **Step 1: Write the failing test**

Create `electron/__tests__/brain-session-source.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createAccountsService, type AccountsService } from '../services/accounts';
import { createSessionSource } from '../services/brain/sources/session-transcripts';
import type { BrainSource } from '../services/brain/sources/types';

const PROMPT = (text: string, i: number) =>
  JSON.stringify({
    type: 'user', uuid: `u${i}`, timestamp: `2026-08-01T10:0${i}:00.000Z`,
    cwd: '/Users/dev/Repos/omnifex', gitBranch: 'main',
    message: { role: 'user', content: text },
  });

const PROSE = (text: string, i: number) =>
  JSON.stringify({
    type: 'assistant', uuid: `a${i}`, timestamp: `2026-08-01T10:0${i}:30.000Z`,
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] },
  });

/** A transcript that clears the gate: two prompts and assistant prose. */
const GOOD = [PROMPT('first ask', 1), PROSE('first answer', 1), PROMPT('second ask', 2), PROSE('second answer', 2)].join('\n');

describe('session transcript source', () => {
  let db: Database;
  let accounts: AccountsService;
  let source: BrainSource;
  let dir: string;
  let personalCfg: string;
  let workCfg: string;
  let personalId: number;
  let workId: number;

  function writeSession(configDir: string, project: string, sessionId: string, body: string): string {
    const projectDir = join(configDir, 'projects', project);
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(file, body, 'utf-8');
    return file;
  }

  beforeEach(() => {
    db = createDatabase(':memory:');
    accounts = createAccountsService(db);
    dir = mkdtempSync(join(tmpdir(), 'brain-sess-'));
    personalCfg = join(dir, 'personal');
    workCfg = join(dir, 'work');
    personalId = accounts.createAccount({ name: 'personal', configDir: personalCfg, engine: 'claude' }).id;
    workId = accounts.createAccount({ name: 'work', configDir: workCfg, engine: 'claude' }).id;
    source = createSessionSource({ accounts });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('discovers a transcript and attributes it to the account whose config dir holds it', async () => {
    writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
    const items = await source.discover();
    expect(items).toHaveLength(1);
    expect(items[0].accountId).toBe(personalId);
    expect(items[0].sourceId).toBe('session');
    expect(items[0].itemKey).toBe('sess-a');
    expect(items[0].size).toBeGreaterThan(0);
  });

  it('never attributes one account transcript to another', async () => {
    writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-personal', GOOD);
    writeSession(workCfg, '-Users-dev-Repos-mango', 'sess-work', GOOD);
    const items = await source.discover();

    // The isolation property, asserted with two accounts in one test because
    // its failure is a confidentiality breach rather than a bug (spec §Testing).
    const personal = items.filter((i) => i.accountId === personalId);
    const work = items.filter((i) => i.accountId === workId);
    expect(personal.map((i) => i.itemKey)).toEqual(['sess-personal']);
    expect(work.map((i) => i.itemKey)).toEqual(['sess-work']);
    expect(personal.every((i) => i.path.startsWith(personalCfg))).toBe(true);
    expect(work.every((i) => i.path.startsWith(workCfg))).toBe(true);
  });

  it("skips OmniFex's own summary scratch transcripts", async () => {
    writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-real', GOOD);
    // The CLI encodes <tmpdir>/omnifex-summary-scratch into a projects dir like
    // any other cwd. These are OmniFex talking to itself; indexing them would
    // fill the Brain with its own summary calls.
    writeSession(personalCfg, '-private-var-folders-xy-T-omnifex-summary-scratch', 'sess-scratch', GOOD);
    const items = await source.discover();
    expect(items.map((i) => i.itemKey)).toEqual(['sess-real']);
  });

  it('ignores sidecar directories and non-jsonl files', async () => {
    writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
    const projectDir = join(personalCfg, 'projects', '-Users-dev-Repos-omnifex');
    // Real layout: <sessionId>/subagents/ and <sessionId>/tool-results/ sit
    // beside the transcript, and *.summary.json sidecars beside that.
    mkdirSync(join(projectDir, 'sess-a', 'subagents'), { recursive: true });
    writeFileSync(join(projectDir, 'sess-a', 'subagents', 'agent-1.jsonl'), GOOD, 'utf-8');
    writeFileSync(join(projectDir, 'sess-a.summary.json'), '{}', 'utf-8');
    const items = await source.discover();
    expect(items.map((i) => i.itemKey)).toEqual(['sess-a']);
  });

  it('returns nothing for an account whose config dir does not exist', async () => {
    await expect(source.discover()).resolves.toEqual([]);
  });

  it('labels an item with its project directory for the Sources pane', async () => {
    writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
    const [item] = await source.discover();
    expect(item.label).toBe('-Users-dev-Repos-omnifex');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run electron/__tests__/brain-session-source.test.ts`
Expected: FAIL — `Cannot find module '../services/brain/sources/session-transcripts'`.

- [ ] **Step 3: Export the scratch directory name so the exclusion cannot drift**

In `electron/services/sessions/summary-query.ts`, change line 41 from `const SCRATCH_DIR_NAME` to:

```ts
/**
 * Exported because the Brain's session source has to EXCLUDE these. The CLI
 * encodes this scratch cwd into a real `projects/<encoded>/` directory, so
 * OmniFex's own summary runs are indistinguishable from user sessions by
 * shape alone — only by name. Two independent spellings of that name would
 * eventually diverge and quietly start indexing them.
 */
export const SCRATCH_DIR_NAME = 'omnifex-summary-scratch';
```

- [ ] **Step 4: Write `discover()` in `sources/session-transcripts.ts`**

```ts
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountsService } from '../../accounts';
import { SCRATCH_DIR_NAME } from '../../sessions/summary-query';
import { distillTranscript } from '../distill';
import type { AdmitVerdict, BrainSource, DistilledItem, SourceItem } from './types';

export interface SessionSourceDeps {
  accounts: AccountsService;
  /** Injectable for tests that need to control transcript reads. */
  readFile?: (path: string) => string;
}

export const SESSION_SOURCE_ID = 'session';

/**
 * A project directory that is really OmniFex's own summary scratch.
 *
 * `sessions/summary-query.ts` pins every summary call to
 * `<os.tmpdir()>/omnifex-summary-scratch`, and the CLI encodes that cwd into a
 * `projects/<encoded>/` directory exactly like a user's repo. The encoding
 * replaces every non-alphanumeric character with `-`, so the scratch name
 * survives as a substring — which is what this matches. Anything else would
 * either miss it (exact match against an unencoded name) or be brittle
 * (reconstructing the whole encoded tmpdir path, which varies per machine).
 */
function isScratchProject(projectDirName: string): boolean {
  return projectDirName.includes(SCRATCH_DIR_NAME);
}

function listDirSafe(path: string): { name: string; isDirectory: boolean }[] {
  try {
    return readdirSync(path, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    }));
  } catch {
    // A config dir that does not exist yet is the ordinary state of a freshly
    // added account, not an error. The Brain is auxiliary: it looks, and if
    // there is nothing there it reports nothing there.
    return [];
  }
}

/**
 * The session-transcript source.
 *
 * Ownership comes from the config dir a transcript LIVES UNDER, via the
 * account list — never from `resolve()` (spec §4). That choice stays correct
 * even when path rules change after a session ran, and it is what stops a work
 * transcript from ever being indexed through the personal account: doing so
 * would push work content through the wrong subscription, a leak in the
 * opposite direction from the retrieval one.
 */
export function createSessionSource(deps: SessionSourceDeps): BrainSource {
  const { accounts } = deps;

  async function discover(): Promise<SourceItem[]> {
    const items: SourceItem[] = [];

    for (const account of accounts.listAccounts()) {
      const projectsDir = join(account.config_dir, 'projects');

      for (const project of listDirSafe(projectsDir)) {
        if (!project.isDirectory) continue;
        if (isScratchProject(project.name)) continue;
        const projectDir = join(projectsDir, project.name);

        for (const entry of listDirSafe(projectDir)) {
          // Top-level `.jsonl` only. `<sessionId>/` directories hold
          // `subagents/` and `tool-results/`; recursing would ingest a
          // subagent's conversation as if it were a user session.
          if (entry.isDirectory) continue;
          if (!entry.name.endsWith('.jsonl')) continue;

          const path = join(projectDir, entry.name);
          let stat;
          try {
            stat = statSync(path);
          } catch {
            // Deleted between the readdir and the stat. Nothing to index.
            continue;
          }

          items.push({
            sourceId: SESSION_SOURCE_ID,
            itemKey: entry.name.slice(0, -'.jsonl'.length),
            accountId: account.id,
            path,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            label: project.name,
          });
        }
      }
    }

    return items;
  }

  // admit() and distill() land in Task 5 and Task 6.
  return { id: SESSION_SOURCE_ID, discover, admit: null as never, distill: null as never };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run electron/__tests__/brain-session-source.test.ts`
Expected: PASS, 6 tests. (`admit`/`distill` are placeholders until the next two tasks; no test calls them yet.)

- [ ] **Step 6: Commit**

```bash
git add electron/services/brain/sources/session-transcripts.ts electron/services/sessions/summary-query.ts electron/__tests__/brain-session-source.test.ts
git commit -m "feat(brain): discover session transcripts per owning account

Ownership derives from the config dir a transcript lives under, never from
resolve() — correct even when path rules change after a session ran.
Excludes OmniFex's own summary-scratch projects and session sidecar
directories, both of which sit alongside real transcripts on disk.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `admit()` — the deterministic gate

Spec §7: skip sessions with fewer than two prompts, sessions that terminated on a startup error, and sessions with no assistant prose. No LLM. If precision proves inadequate, an LLM classifier slots in behind this same call.

The startup-error signal is real, not invented: a live transcript carries `{"type":"assistant","isApiErrorMessage":true,...}` with text `Not logged in · Please run /login`. That is the shape the gate matches.

**Files:**
- Modify: `electron/services/brain/sources/session-transcripts.ts`
- Create: `electron/__tests__/fixtures/brain/session-startup-error.jsonl`
- Modify: `electron/__tests__/brain-session-source.test.ts`

**Interfaces:**
- Consumes: `distillTranscript` from `../distill` (the gate reads the same metadata the distiller computes — one parse, one set of rules).
- Produces: `BrainSource.admit(item: SourceItem): AdmitVerdict`.

- [ ] **Step 1: Build the startup-error fixture**

Create `electron/__tests__/fixtures/brain/session-startup-error.jsonl`:

```jsonl
{"type":"user","uuid":"u1","sessionId":"sess-err","timestamp":"2026-08-01T10:00:00.000Z","cwd":"/Users/dev/Repos/omnifex","message":{"role":"user","content":"fix the failing test"}}
{"type":"assistant","uuid":"a1","sessionId":"sess-err","timestamp":"2026-08-01T10:00:01.000Z","isApiErrorMessage":true,"message":{"role":"assistant","content":[{"type":"text","text":"Not logged in · Please run /login"}]}}
```

- [ ] **Step 2: Write the failing tests**

Add to `electron/__tests__/brain-session-source.test.ts`:

```ts
  describe('admit', () => {
    const ONE_PROMPT = [PROMPT('just this one', 1), PROSE('an answer', 1)].join('\n');
    const NO_PROSE = [PROMPT('first', 1), PROMPT('second', 2)].join('\n');

    it('admits a session with two prompts and assistant prose', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const [item] = await source.discover();
      const verdict = source.admit(item);
      expect(verdict.admitted).toBe(true);
      expect(verdict.reason).toBeTruthy();
    });

    it('skips a session with fewer than two prompts', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', ONE_PROMPT);
      const [item] = await source.discover();
      const verdict = source.admit(item);
      expect(verdict.admitted).toBe(false);
      // The reason is what the Sources pane shows, so it has to name the rule
      // that fired rather than say "skipped".
      expect(verdict.reason).toContain('prompt');
    });

    it('skips a session with no assistant prose', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', NO_PROSE);
      const [item] = await source.discover();
      expect(source.admit(item)).toMatchObject({ admitted: false });
      expect(source.admit(item).reason).toContain('prose');
    });

    it('skips a session that terminated on a startup error', async () => {
      const fixture = readFileSync(join(__dirname, 'fixtures', 'brain', 'session-startup-error.jsonl'), 'utf-8');
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-err', fixture);
      const [item] = await source.discover();
      const verdict = source.admit(item);
      expect(verdict.admitted).toBe(false);
      expect(verdict.reason).toContain('error');
    });

    it('skips an unreadable transcript instead of throwing', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const [item] = await source.discover();
      rmSync(item.path);
      // The Brain is auxiliary: a vanished file is a skip with a reason, never
      // an exception into whatever is draining the queue.
      expect(() => source.admit(item)).not.toThrow();
      expect(source.admit(item).admitted).toBe(false);
    });
  });
```

Add `readFileSync` to the `node:fs` import at the top of the file.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run electron/__tests__/brain-session-source.test.ts -t admit`
Expected: FAIL — `source.admit is not a function` (it is the `null as never` placeholder).

- [ ] **Step 4: Implement `admit()`**

In `session-transcripts.ts`, add the read helper and the gate, and replace the placeholder in the returned object:

```ts
/** Minimum prompts for a session to be worth a note (spec §7). */
const MIN_PROMPTS = 2;

// ... inside createSessionSource, above discover():

  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf-8'));

  /**
   * Read and distil an item, or null when it cannot be read.
   *
   * `admit()` and `distill()` both need the same parse, and both must tolerate
   * a file that vanished — sessions are deleted from the app's own UI, and a
   * discovery list is a snapshot, not a lock.
   */
  function distillItem(item: SourceItem): DistilledItem | null {
    try {
      return distillTranscript(readFile(item.path), item.itemKey);
    } catch {
      return null;
    }
  }

  /**
   * The admission gate: deterministic, no LLM (spec §7).
   *
   * These three rules drop the open-a-tab-and-close-it noise that would
   * otherwise dominate the vault. Each returns the rule it fired on, because
   * the Sources pane's whole job this step is letting a human check the gate's
   * judgement before Plan 4 spends a token acting on it.
   *
   * If precision proves inadequate, an LLM classifier slots in BEHIND this
   * same call — the interface does not change.
   */
  function admit(item: SourceItem): AdmitVerdict {
    const distilled = distillItem(item);
    if (!distilled) {
      return { admitted: false, reason: 'transcript could not be read' };
    }
    const { promptCount, proseCount, terminalStatus } = distilled.metadata;

    // Checked before the prompt count: a session that died on `Not logged in`
    // usually has exactly one prompt too, and "startup error" is the more
    // useful thing to tell the user.
    if (terminalStatus === 'error' && proseCount <= 1) {
      return { admitted: false, reason: 'terminated on a startup error' };
    }
    if (promptCount < MIN_PROMPTS) {
      return {
        admitted: false,
        reason: `fewer than ${MIN_PROMPTS} prompts (${promptCount})`,
      };
    }
    if (proseCount === 0) {
      return { admitted: false, reason: 'no assistant prose' };
    }
    return {
      admitted: true,
      reason: `${promptCount} prompts, ${proseCount} assistant replies`,
    };
  }
```

Add `readFileSync` to the `node:fs` import, and return `admit` instead of the placeholder:

```ts
  return { id: SESSION_SOURCE_ID, discover, admit, distill: null as never };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run electron/__tests__/brain-session-source.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add electron/services/brain/sources/session-transcripts.ts electron/__tests__/brain-session-source.test.ts electron/__tests__/fixtures/brain/session-startup-error.jsonl
git commit -m "feat(brain): deterministic admission gate for session transcripts

Skips sessions under two prompts, with no assistant prose, or that died on
a startup error (the real isApiErrorMessage shape, from a live transcript).
Returns a verdict with the rule that fired rather than a bare boolean, so
the Sources pane can show why something was skipped.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: `distill()` on the adapter, and wire the source into `BrainService`

**Files:**
- Modify: `electron/services/brain/sources/session-transcripts.ts`
- Modify: `electron/services/brain/registry.ts`
- Modify: `electron/main.ts` (service construction at :444)
- Modify: `electron/__tests__/brain-session-source.test.ts`

**Interfaces:**
- Consumes: `createSessionSource`, `createSourceStateStore`, `AccountsService`.
- Produces, on `BrainService`:
  - `listSources(accountId: number): SourceSummary[]`
  - `previewSource(accountId: number, itemKey: string): SourcePreview | null`
  - and the types:

```ts
export interface SourceSummary {
  accountId: number;
  sourceId: string;
  itemKey: string;
  label: string;
  mtimeMs: number;
  admitted: boolean;
  reason: string;
  /** Recorded state, or null when this item has never been through indexing. */
  status: SourceStatus | null;
  changed: boolean;
}

export interface SourcePreview {
  itemKey: string;
  prose: string;
  metadata: SessionMetadata;
  truncated: boolean;
  admitted: boolean;
  reason: string;
}
```

- [ ] **Step 1: Write the failing tests**

Add to `electron/__tests__/brain-session-source.test.ts`:

```ts
  describe('distill', () => {
    it('returns bounded prose and metadata for an item', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const [item] = await source.discover();
      const distilled = await source.distill(item);
      expect(distilled.prose).toContain('USER: first ask');
      expect(distilled.prose).toContain('ASSISTANT: first answer');
      expect(distilled.metadata.sessionId).toBe('sess-a');
      expect(distilled.metadata.promptCount).toBe(2);
    });

    it('rejects rather than inventing output when the transcript is gone', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const [item] = await source.discover();
      rmSync(item.path);
      // Unlike admit(), which degrades to a skip verdict, distill() has no
      // truthful empty answer: returning empty prose would let Plan 4 write a
      // note asserting the session had nothing in it.
      await expect(source.distill(item)).rejects.toThrow(/cannot read/i);
    });
  });
```

Add to `electron/__tests__/brain-session-source.test.ts` — service-level wiring. It goes here, not in `brain-ipc.test.ts`: that file deliberately uses bare account ids (`1`, `2`) with no `accounts` rows, and this assertion needs real config dirs on disk for discovery to walk.

```ts
  describe('BrainService source wiring', () => {
    it('lists sources for one account only, with verdicts and change state', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-personal', GOOD);
      writeSession(workCfg, '-Users-dev-Repos-mango', 'sess-work', GOOD);
      const brain = createBrainService(db, {
        execGit: async () => '',
        sources: [createSessionSource({ accounts })],
      });

      const summaries = await brain.listSources(personalId);

      // The isolation property at the service boundary: listSources must
      // answer for exactly the account asked about.
      expect(summaries.every((s) => s.accountId === personalId)).toBe(true);
      expect(summaries.map((s) => s.itemKey)).toEqual(['sess-personal']);
      expect(summaries[0]).toMatchObject({ admitted: true, status: null, changed: true });
      brain.closeAll();
    });

    it('will not preview another account item even when the key is known', async () => {
      writeSession(workCfg, '-Users-dev-Repos-mango', 'sess-work', GOOD);
      const brain = createBrainService(db, {
        execGit: async () => '',
        sources: [createSessionSource({ accounts })],
      });
      // A session id is unique per account, not globally. Matching on the key
      // alone would hand a work transcript to whoever asked as personal.
      await expect(brain.previewSource(personalId, 'sess-work')).resolves.toBeNull();
      brain.closeAll();
    });
  });
```

Add `createBrainService` to this file's imports.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run electron/__tests__/brain-session-source.test.ts -t distill`
Expected: FAIL — `source.distill is not a function`.

- [ ] **Step 3: Implement `distill()` on the adapter**

In `session-transcripts.ts`:

```ts
  /**
   * The bounded prose Plan 4's extractor will run on.
   *
   * Rejects on an unreadable transcript rather than resolving with empty
   * prose. `admit()` can degrade to a verdict because "skip this" is a
   * truthful answer to a missing file; `distill()` has no such answer, and
   * empty prose would let the extractor write a note asserting the session
   * contained nothing.
   */
  async function distill(item: SourceItem): Promise<DistilledItem> {
    const distilled = distillItem(item);
    if (!distilled) throw new Error(`cannot read transcript: ${item.path}`);
    return distilled;
  }
```

Return it: `return { id: SESSION_SOURCE_ID, discover, admit, distill };`

- [ ] **Step 4: Add `listSources` / `previewSource` to `BrainService`**

In `registry.ts`, extend `BrainServiceOptions` (added in Task 1) and the service interface:

```ts
export interface BrainServiceOptions {
  execGit?: ExecGit;
  /**
   * Source adapters this service can enumerate. Injected rather than
   * constructed here so the registry stays free of any knowledge of where
   * transcripts live — and so tests can supply a fake source without a config
   * dir on disk.
   */
  sources?: BrainSource[];
}
```

Add to the `BrainService` interface:

```ts
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
  listSources(accountId: number): Promise<SourceSummary[]>;
  /** Distilled preview of one item, or null when it is not this account's. */
  previewSource(accountId: number, itemKey: string): Promise<SourcePreview | null>;
```

Implementation inside `createBrainService`:

```ts
  const sources = opts.sources ?? [];
  const sourceState = createSourceStateStore(db);

  async function listSources(accountId: number): Promise<SourceSummary[]> {
    requireAccountId(accountId);
    const summaries: SourceSummary[] = [];
    for (const source of sources) {
      const items = await source.discover();
      for (const item of items) {
        // The filter that makes this account-scoped. An item belonging to
        // another account is not merely uninteresting here — surfacing it
        // would put one account's project names in another's UI.
        if (item.accountId !== accountId) continue;
        const verdict = source.admit(item);
        const prior = sourceState.get(accountId, item.sourceId, item.itemKey);
        summaries.push({
          accountId,
          sourceId: item.sourceId,
          itemKey: item.itemKey,
          label: item.label,
          mtimeMs: item.mtimeMs,
          admitted: verdict.admitted,
          reason: verdict.reason,
          status: prior?.status ?? null,
          changed: sourceState.hasChanged(item),
        });
      }
    }
    summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return summaries;
  }

  async function previewSource(
    accountId: number,
    itemKey: string,
  ): Promise<SourcePreview | null> {
    requireAccountId(accountId);
    for (const source of sources) {
      const items = await source.discover();
      const item = items.find((i) => i.itemKey === itemKey && i.accountId === accountId);
      // Matching on BOTH keys, not just itemKey: a session id is unique per
      // account, not globally, and matching on the key alone would preview
      // another account's transcript to whoever guessed the id.
      if (!item) continue;
      const verdict = source.admit(item);
      const distilled = await source.distill(item);
      return {
        itemKey,
        prose: distilled.prose,
        metadata: distilled.metadata,
        truncated: distilled.truncated,
        admitted: verdict.admitted,
        reason: verdict.reason,
      };
    }
    return null;
  }
```

Add both to the returned object.

- [ ] **Step 5: Wire the real source in `main.ts`**

At `electron/main.ts:444`, replace the construction with:

```ts
  const brainService: BrainService | undefined = createBrainService(db, {
    sources: [createSessionSource({ accounts: accountsService })],
  });
```

Import `createSessionSource` from `./services/brain/sources/session-transcripts`. Confirm the accounts service variable's actual name at that point in `main.ts` before editing — it is constructed above this line.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run electron/__tests__/brain-session-source.test.ts electron/__tests__/brain-ipc.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add electron/services/brain electron/main.ts electron/__tests__
git commit -m "feat(brain): expose discovered sources and distilled previews on BrainService

listSources/previewSource filter to one account after discovery rather
than letting a caller assert ownership, and previewSource matches on
account AND item key — a session id is unique per account, not globally.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: IPC channels and the renderer API

**Files:**
- Modify: `electron/ipc/channels.ts` (brain block at :14-25)
- Modify: `electron/ipc/brain-handlers.ts`
- Modify: `src/lib/api.ts` (types near :998, methods near :2895)
- Modify: `electron/__tests__/brain-ipc.test.ts` (the `CHANNELS` list at :19)

**Interfaces:**
- Produces: channels `brain_list_sources`, `brain_source_preview`; api methods `brainListSources(accountId)`, `brainSourcePreview(accountId, itemKey)`.

- [ ] **Step 1: Add the failing channel test**

In `electron/__tests__/brain-ipc.test.ts`, add both names to the `CHANNELS` array (it asserts every brain channel is registered), then add:

Follow this file's existing conventions: the event argument is `null`, and account ids are bare numbers with no `accounts` rows behind them.

```ts
  it('rejects a source listing with no accountId', async () => {
    // Same rule as every other brain handler: defaulting the account would
    // read the wrong vault's material, which is a confidentiality failure
    // rather than a UX annoyance.
    await expect(handlers.brain_list_sources(null, {})).rejects.toThrow(/accountId/);
  });

  it('accepts snake_case params and returns null for an unknown item', async () => {
    // No sources are wired into this file's service, so discovery finds
    // nothing and the preview is null — which is the point: the handler must
    // pass both params through and not throw.
    await expect(
      handlers.brain_source_preview(null, { account_id: 1, item_key: 'nope' }),
    ).resolves.toBeNull();
  });

  it('degrades to an empty list when the service is unavailable', async () => {
    const bare = createBrainHandlers(undefined);
    await expect(bare.brain_list_sources(null, { accountId: 1 })).resolves.toEqual([]);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run electron/__tests__/brain-ipc.test.ts`
Expected: FAIL — the channel-registration assertion reports `brain_list_sources` missing.

- [ ] **Step 3: Register the channels**

In `electron/ipc/channels.ts`, after `'brain_backlinks'`:

```ts
  'brain_list_sources',
  'brain_source_preview',
```

In `electron/ipc/brain-handlers.ts`:

```ts
    async brain_list_sources(_event, params = {}) {
      const accountId = requireAccountId(params);
      // A read path, so it degrades to [] when the service failed to
      // construct — matching brain_list_notes and the "Brain is auxiliary"
      // rule in this file's module doc.
      if (!brain) return [];
      return brain.listSources(accountId);
    },

    async brain_source_preview(_event, params = {}) {
      const accountId = requireAccountId(params);
      if (!brain) return null;
      return brain.previewSource(accountId, requireString(params, 'itemKey', 'item_key'));
    },
```

In `src/lib/api.ts`, beside the other Brain mirrors:

```ts
/** Mirrors the backend `SourceSummary` in electron/services/brain/registry.ts. */
export interface BrainSourceSummary {
  accountId: number;
  sourceId: string;
  itemKey: string;
  label: string;
  mtimeMs: number;
  admitted: boolean;
  reason: string;
  status: 'pending' | 'indexed' | 'skipped' | 'failed' | 'blocked' | null;
  changed: boolean;
}

/** Mirrors the backend `SessionMetadata` in electron/services/brain/sources/types.ts. */
export interface BrainSessionMetadata {
  sessionId: string;
  projectPath: string | null;
  gitBranch: string | null;
  models: string[];
  cliVersion: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  promptCount: number;
  proseCount: number;
  filesTouched: string[];
  terminalStatus: 'completed' | 'error' | 'unknown';
}

/** Mirrors the backend `SourcePreview` in electron/services/brain/registry.ts. */
export interface BrainSourcePreview {
  itemKey: string;
  prose: string;
  metadata: BrainSessionMetadata;
  truncated: boolean;
  admitted: boolean;
  reason: string;
}
```

and the methods:

```ts
  async brainListSources(accountId: number): Promise<BrainSourceSummary[]> {
    return apiCall<BrainSourceSummary[]>('brain_list_sources', { accountId });
  },

  async brainSourcePreview(
    accountId: number,
    itemKey: string,
  ): Promise<BrainSourcePreview | null> {
    return apiCall<BrainSourcePreview | null>('brain_source_preview', { accountId, itemKey });
  },
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run electron/__tests__/brain-ipc.test.ts && npm run check`
Expected: PASS and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add electron/ipc src/lib/api.ts electron/__tests__/brain-ipc.test.ts
git commit -m "feat(brain): IPC and renderer API for source listing and preview

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The Sources pane

The inspection surface this build step exists for. It is **not** the operational pane from spec §14 — queue depth, Index-now, pause, kill switch land in Plan 4 with the worker that makes them mean anything.

**Files:**
- Create: `src/components/brain/BrainSources.tsx`
- Modify: `src/components/brain/BrainTab.tsx`
- Test: `src/components/__tests__/BrainSources.test.tsx`

**Interfaces:**
- Consumes: `api.brainListSources`, `api.brainSourcePreview`, `BrainSourceSummary`, `BrainSourcePreview`.
- Produces: `<BrainSources accountId={number | null} />`.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/BrainSources.test.tsx`, following the existing mock style in `BrainNoteList.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrainSources } from '../brain/BrainSources';

const listSources = vi.fn();
const sourcePreview = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    brainListSources: (...args: unknown[]) => listSources(...args),
    brainSourcePreview: (...args: unknown[]) => sourcePreview(...args),
  },
}));

const summary = (over = {}) => ({
  accountId: 1, sourceId: 'session', itemKey: 'sess-a', label: '-Users-dev-omnifex',
  mtimeMs: 1_700_000_000_000, admitted: true, reason: '4 prompts, 3 assistant replies',
  status: null, changed: true, ...over,
});

describe('BrainSources', () => {
  beforeEach(() => {
    listSources.mockReset();
    sourcePreview.mockReset();
  });

  it('lists discovered items for the given account', async () => {
    listSources.mockResolvedValue([summary()]);
    render(<BrainSources accountId={1} />);
    expect(await screen.findByText('sess-a')).toBeInTheDocument();
    expect(listSources).toHaveBeenCalledWith(1);
  });

  it('shows why a skipped item was skipped', async () => {
    listSources.mockResolvedValue([summary({ admitted: false, reason: 'fewer than 2 prompts (1)' })]);
    render(<BrainSources accountId={1} />);
    expect(await screen.findByText(/fewer than 2 prompts/)).toBeInTheDocument();
  });

  it('loads the distilled preview when an item is selected', async () => {
    listSources.mockResolvedValue([summary()]);
    sourcePreview.mockResolvedValue({
      itemKey: 'sess-a', prose: 'USER: do the thing', truncated: false,
      admitted: true, reason: 'ok',
      metadata: { sessionId: 'sess-a', projectPath: '/repo', gitBranch: 'main', models: ['claude-opus-5'],
        cliVersion: '2.1.228', startedAt: null, endedAt: null, durationMs: null,
        promptCount: 4, proseCount: 3, filesTouched: [], terminalStatus: 'completed' },
    });
    render(<BrainSources accountId={1} />);
    await userEvent.click(await screen.findByText('sess-a'));
    expect(await screen.findByText(/USER: do the thing/)).toBeInTheDocument();
    expect(sourcePreview).toHaveBeenCalledWith(1, 'sess-a');
  });

  it('drops the selection when the account changes', async () => {
    listSources.mockResolvedValue([summary()]);
    sourcePreview.mockResolvedValue({
      itemKey: 'sess-a', prose: 'PERSONAL PROSE', truncated: false, admitted: true, reason: 'ok',
      metadata: { sessionId: 'sess-a', projectPath: null, gitBranch: null, models: [],
        cliVersion: null, startedAt: null, endedAt: null, durationMs: null,
        promptCount: 2, proseCount: 2, filesTouched: [], terminalStatus: 'completed' },
    });
    const { rerender } = render(<BrainSources accountId={1} />);
    await userEvent.click(await screen.findByText('sess-a'));
    await screen.findByText(/PERSONAL PROSE/);

    listSources.mockResolvedValue([]);
    rerender(<BrainSources accountId={2} />);
    // An item key is only meaningful inside the account it came from. Holding
    // a selection across a switch would render one account's distilled
    // transcript under another account's header — the same rule BrainTab
    // applies to note selection.
    await waitFor(() => {
      expect(screen.queryByText(/PERSONAL PROSE/)).not.toBeInTheDocument();
    });
  });

  it('renders nothing to inspect when no account is selected', () => {
    render(<BrainSources accountId={null} />);
    expect(listSources).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/__tests__/BrainSources.test.tsx`
Expected: FAIL — cannot resolve `../brain/BrainSources`.

- [ ] **Step 3: Write `BrainSources.tsx`**

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { api, type BrainSourcePreview, type BrainSourceSummary } from '@/lib/api';

/**
 * The Sources pane: what the session adapter found, what the gate decided,
 * and what a distilled transcript actually looks like.
 *
 * This is the whole reason step 3 of the build sequence exists before step 4.
 * If distillation output looks like noise here, no API budget was spent
 * finding that out.
 *
 * It is NOT the operational pane from spec §14 — queue depth, Index-now,
 * pause, kill switch. Those arrive in Plan 4 with the worker that gives them
 * something to control; an operations panel over a queue nothing drains would
 * be a control surface for nothing.
 */
export const BrainSources: React.FC<{ accountId: number | null }> = ({ accountId }) => {
  const [items, setItems] = useState<BrainSourceSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<BrainSourcePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Both are account-scoped: carrying either across a switch would render
    // one account's material under another account's header.
    setSelected(null);
    setPreview(null);
  }, [accountId]);

  useEffect(() => {
    if (accountId === null) return;
    let cancelled = false;
    setLoading(true);
    api
      .brainListSources(accountId)
      .then((rows) => { if (!cancelled) { setItems(rows); setError(null); } })
      .catch((err: Error) => { if (!cancelled) { setItems([]); setError(err.message); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accountId]);

  const select = useCallback((itemKey: string) => {
    if (accountId === null) return;
    setSelected(itemKey);
    setPreview(null);
    api
      .brainSourcePreview(accountId, itemKey)
      .then(setPreview)
      .catch((err: Error) => setError(err.message));
  }, [accountId]);

  if (accountId === null) {
    return <div className="p-4 text-xs text-muted-foreground">Select an account.</div>;
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="w-80 shrink-0 overflow-y-auto border-r">
        {loading && <div className="p-3 text-xs text-muted-foreground">scanning…</div>}
        {!loading && items.length === 0 && (
          <div className="p-3 text-xs text-muted-foreground">No transcripts found.</div>
        )}
        {items.map((item) => (
          <button
            key={`${item.sourceId}:${item.itemKey}`}
            type="button"
            onClick={() => select(item.itemKey)}
            aria-pressed={selected === item.itemKey}
            className={`block w-full border-b px-3 py-2 text-left text-xs hover:bg-accent ${
              selected === item.itemKey ? 'bg-accent' : ''
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  item.admitted ? 'bg-emerald-500' : 'bg-muted-foreground/40'
                }`}
              />
              <span className="truncate font-medium">{item.itemKey}</span>
            </div>
            <div className="truncate text-muted-foreground">{item.label}</div>
            <div className="truncate text-muted-foreground">{item.reason}</div>
          </button>
        ))}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        {error && <div className="mb-3 text-xs text-destructive">{error}</div>}
        {!selected && <div className="text-xs text-muted-foreground">Select an item to preview its distillation.</div>}
        {selected && !preview && !error && <div className="text-xs text-muted-foreground">distilling…</div>}
        {preview && (
          <>
            <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <dt className="text-muted-foreground">project</dt>
              <dd className="truncate">{preview.metadata.projectPath ?? '—'}</dd>
              <dt className="text-muted-foreground">branch</dt>
              <dd>{preview.metadata.gitBranch ?? '—'}</dd>
              <dt className="text-muted-foreground">models</dt>
              <dd>{preview.metadata.models.join(', ') || '—'}</dd>
              <dt className="text-muted-foreground">turns</dt>
              <dd>{preview.metadata.promptCount} prompts · {preview.metadata.proseCount} replies</dd>
              <dt className="text-muted-foreground">files</dt>
              <dd>{preview.metadata.filesTouched.length}</dd>
              <dt className="text-muted-foreground">outcome</dt>
              <dd>{preview.metadata.terminalStatus}</dd>
            </dl>
            {preview.truncated && (
              <div className="mb-2 text-xs text-amber-600">
                Truncated to the 8KB ceiling — oldest turns dropped.
              </div>
            )}
            <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
              {preview.prose}
            </pre>
          </>
        )}
      </div>
    </div>
  );
};

export default BrainSources;
```

- [ ] **Step 4: Add the Notes / Sources toggle to `BrainTab.tsx`**

Add the state beside the existing `showVault` toggle:

```tsx
  const [pane, setPane] = useState<'notes' | 'sources'>('notes');
  // Same rule as note selection: a pane choice is harmless across accounts,
  // but the data behind it is not, so both children re-derive from accountId.
  useEffect(() => { setPane('notes'); }, [accountId]);
```

Render the switch in the header, before the Vault button:

```tsx
        {!needsSetup && (
          <div className="flex items-center gap-1 text-xs">
            {(['notes', 'sources'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPane(p)}
                aria-pressed={pane === p}
                className={`rounded-md px-2 py-1 capitalize hover:bg-accent ${
                  pane === p ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        )}
```

and branch the body: when `pane === 'sources'`, render `<BrainSources accountId={accountId} />` in place of the note-list/viewer pair.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/components/__tests__/BrainSources.test.tsx src/components/__tests__/BrainTab.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/brain src/components/__tests__/BrainSources.test.tsx
git commit -m "feat(brain): Sources pane for inspecting distilled transcripts

The reason step 3 ships before step 4: if distillation output looks like
noise, no API budget was spent finding that out. Not the operational pane
from spec §14 — that lands with Plan 4's worker.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Full verification and the deferred-items record

**Files:**
- Modify: `docs/superpowers/plans/2026-08-11-brain-vault-followups.md`

- [ ] **Step 1: Run the whole gate**

```bash
npm run check
npm run build
npm run test:coverage
```

Expected: clean typecheck, successful build, all tests passing. Confirm the new backend files clear 80% lines in the coverage report: `electron/services/brain/distill.ts`, `sources/state.ts`, `sources/session-transcripts.ts`. If any is short, add the missing cases rather than lowering the bar.

- [ ] **Step 2: Rebuild the native module for Electron**

```bash
npm run rebuild:electron
```

Vitest leaves `better-sqlite3` built for Node; without this the app fails to start with an ABI mismatch.

- [ ] **Step 3: Look at real output before declaring the step done**

Launch the app, open the Brain tab, switch to Sources, and read several distilled previews from genuinely different sessions — a long one that truncates, a short one that gets skipped, one from each account. This is the manual gate the whole build sequence is ordered around. Note anything that reads like noise; that judgement is the input to Plan 4's extraction prompt.

- [ ] **Step 4: Update the follow-ups record**

In `docs/superpowers/plans/2026-08-11-brain-vault-followups.md`, move the ExecGit item out of "Still open" into a closed record naming this branch, and add anything this plan deferred. Known deferrals to write down:

- The `'.omnifex'` / `'.git'` shared-constant lift and the `ctx.skip()` fix are still open — deliberately not folded into this branch.
- `walkToRealAncestor` extraction — still open, unchanged.
- `listSources` and `previewSource` each call `discover()`, which walks every account's projects tree. Fine at hundreds of sessions on a warm page cache; if a config dir ever holds thousands, cache the discovery result per call rather than making the walk lazier.
- Distillation currently ignores the `.summary.json` sidecars sitting beside transcripts. They are already-generated prose about the same session, so Plan 4 may want them as extractor input rather than re-deriving; deliberately out of scope here because they are optional, model-generated, and this step spends no tokens.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-08-11-brain-vault-followups.md
git commit -m "docs: record what Plan 3 closed and what it deferred

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Finish the branch**

**REQUIRED SUB-SKILL:** Use superpowers:finishing-a-development-branch.

---

## Self-Review

**Spec coverage.** §5 source adapters → Tasks 2, 4, 5, 6 (the full `BrainSource` interface, with the two stated deviations). §5 change detection in `brain_sources` → Task 2. §6 distillation, prompt anchoring, 8KB oldest-first ceiling, deterministic metadata → Task 3. §7 admission gate → Task 5. §4 ownership via `getAccountByConfigDir` and no silent fallback → Task 4. §Testing's isolation property → Task 4's two-account test and Task 6's service-level one. §14's operational pane is explicitly **not** covered and is recorded as deferred to Plan 4, with the reason.

**Not covered, on purpose:** §8 extraction, §9 merge, §10 curation, §11 queue, §13 MCP server, §15 `/recall`. All are steps 4–7 of the build sequence and all involve either an LLM or a worker this step deliberately precedes.

**Type consistency check.** `SourceItem`, `AdmitVerdict`, `DistilledItem`, `SessionMetadata` are defined once in `sources/types.ts` and referenced by exact name in Tasks 3–8. `SourceStatus` is defined in `sources/state.ts` and mirrored as a literal union in `src/lib/api.ts` (the renderer cannot import from `electron/`). `SourceSummary` / `SourcePreview` are defined in Task 6 and mirrored in Task 7. `promptCount` / `proseCount` keep those names in the backend metadata, the API mirror, and the pane. `DISTILL_MAX_CHARS` is the single ceiling constant.

**One thing an implementer will hit.** Task 6 Step 5 edits `main.ts` where the accounts service is already in scope; check the variable's real name at that line rather than trusting the snippet's `accountsService`.
