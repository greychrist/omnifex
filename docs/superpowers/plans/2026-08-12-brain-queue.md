# Brain Queue and Worker Implementation Plan (Plan 4b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drain admitted sessions into their vaults unattended — a restart-surviving `brain_queue`, a single-concurrency worker that yields entirely to interactive sessions, an explicit backfill, and the operational pane spec §14 promised.

**Architecture:** `brain_queue` (schema v18, currently unused) gets a store that owns claim/complete/fail and recovers orphaned `running` rows at startup. A worker drains it one item at a time by calling the `indexSource` Plan 4a already built, pausing whenever any interactive session exists. Enqueue happens on session close through the callback `main.ts` already passes to the sessions service, gated by a setting that is **off by default**.

**Tech Stack:** TypeScript, Electron main process, `better-sqlite3`, Vitest, React 18 + Tailwind v4.

## Global Constraints

- **The worker yields entirely while any interactive session is active** (spec §11). Indexing must never compete with the user for rate limit.
- **Use `listActiveTabIds()`, never `listInFlightTabIds()`.** The latter is hardcoded to `return []` (`sessions/lifecycle.ts:511`, dead since the jsonl-as-rendered refactor) and `docs/session-lifecycle.md:139` explicitly names relying on it as an anti-pattern. A worker gated on it would never yield — it would run hardest exactly when the user is working, which is the failure the yield rule exists to prevent.
- **Auto-indexing is OFF by default.** The worker ships fully built but idle until the user opts in once. Backfill is an explicit action.
- Concurrency 1. `BATCH_SIZE = 1` end to end (spec §8).
- The queue survives restart, is visible and pausable in the Brain tab, and has a global kill switch (spec §11, §14).
- A failed item never blocks the queue (spec §8).
- **Every drain path goes through `indexSource`**, which already refuses to re-extract an unchanged, already-indexed item. Bypassing it would reintroduce the non-idempotency Plan 4a fixed.
- Account isolation holds: an item is indexed by, and into, its owning account (spec §4).
- TDD; 80% lines backend. Gate: `npm run check`, `npm run build`, `npm run test:coverage`, `npm run rebuild:electron`.

## Decisions Carried In

1. **Auto-index off by default**, one setting to opt in.
2. **Worker yields while any session is active** — spec-literal, no idle delay, no nightly window.
3. **Backfill everything** when the user asks for it. Revised cost: Sonnet ran 13.6s and 43.5s on two live extractions, so ~142 sessions is roughly 30–100 minutes serial, not the six hours the Haiku measurement implied.

## Prior Art To Read Before Starting

- `docs/session-lifecycle.md` — required by CLAUDE.md for anything touching the in-flight predicate. Read §"The in-flight rollup" and the anti-pattern list before writing the yield gate.
- `electron/main.ts:664-688` — the on-close callback already wired into the sessions service, carrying `(sessionId, projectPath, configDir)`. `configDir` is the owning account's directory, which is exactly the ownership signal spec §4 requires. This is the enqueue hook; do not build a new one.
- `electron/services/database.ts:74-86` — `brain_queue` DDL, already migrated, never used.
- `electron/services/brain/registry.ts` — `indexSource(accountId, itemKey, { force })`, `listSources`.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `electron/services/brain/queue.ts` | `brain_queue` store + the drain worker. The only file that knows the table's columns. |
| `electron/__tests__/brain-queue.test.ts` | Queue semantics, restart recovery, yielding, failure isolation. |
| `src/components/brain/BrainQueuePanel.tsx` | Operational pane: depth, current item, failures, controls. |
| `src/components/__tests__/BrainQueuePanel.test.tsx` | Pane rendering and controls. |

**Modified:** `electron/services/brain/registry.ts` (expose queue ops), `electron/ipc/brain-handlers.ts`, `electron/ipc/channels.ts`, `electron/main.ts`, `src/lib/api.ts`, `src/components/brain/BrainSources.tsx`, plus test files.

---

### Task 1: The queue store

**Files:**
- Create: `electron/services/brain/queue.ts`
- Test: `electron/__tests__/brain-queue.test.ts`

**Interfaces:**

```ts
export type QueueStatus = 'pending' | 'running' | 'done' | 'failed';

export interface QueueEntry {
  id: number;
  accountId: number;
  sourceId: string;
  itemKey: string;
  status: QueueStatus;
  error: string | null;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface QueueCounts {
  pending: number; running: number; done: number; failed: number;
}

export interface BrainQueueStore {
  /** Idempotent: re-enqueuing a pending or running item is a no-op. */
  enqueue(accountId: number, sourceId: string, itemKey: string): void;
  /** Oldest pending entry, marked running. Null when the queue is empty. */
  claimNext(): QueueEntry | null;
  complete(id: number): void;
  fail(id: number, error: string): void;
  counts(accountId?: number): QueueCounts;
  list(accountId: number, limit?: number): QueueEntry[];
  /** Reset orphaned `running` rows to pending. Call once at startup. */
  recoverOrphans(): number;
  clearFinished(accountId: number): void;
}
```

- [ ] **Step 1: Write the failing tests**

Cover, with `createDatabase(':memory:')`:

```ts
  it('enqueues and claims in FIFO order');
  it('is idempotent: re-enqueuing a pending item does not duplicate it');
  it('re-enqueues an item that already finished', () => {
    // A session the user continued is genuinely new material. The UNIQUE
    // constraint is on (account, source, item), so a finished row must be
    // reset to pending rather than rejected — otherwise a session can only
    // ever be indexed once in the lifetime of the database.
  });
  it('claimNext marks the entry running and stamps startedAt');
  it('claimNext returns null on an empty queue');
  it('never hands the same entry to two claims');
  it('complete and fail move an entry out of pending, and fail records the error');
  it('a failed entry does not block the next claim', () => {
    // Spec §8: a failed item never blocks the queue.
  });
  it('recoverOrphans resets running rows to pending and reports how many', () => {
    // A crash or quit mid-item leaves `running` forever. Without this the
    // queue silently stops draining after one bad shutdown, and the Brain
    // tab shows an item that is not actually being worked on.
  });
  it('counts are per account when an account is given, global otherwise');
  it('list is newest-first and respects its limit');
  it('clearFinished removes done and failed rows but leaves pending untouched');
```

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run electron/__tests__/brain-queue.test.ts`

- [ ] **Step 3: Implement the store.**

Key SQL decisions, all pinned by the tests above:

- `enqueue` is `INSERT ... ON CONFLICT (account_id, source_id, item_key) DO UPDATE SET status='pending', error=NULL, enqueued_at=CURRENT_TIMESTAMP, started_at=NULL, finished_at=NULL WHERE brain_queue.status IN ('done','failed')`. The `WHERE` is what makes re-enqueuing a *pending or running* item a no-op while still allowing a finished one to be redone.
- `claimNext` runs `SELECT ... WHERE status='pending' ORDER BY id LIMIT 1` and the `UPDATE ... SET status='running'` inside **one `db.raw.transaction`**, so two concurrent claims cannot both see the same row. Concurrency is 1 today, but a claim that is only atomic by luck is a bug waiting for the day it is not.
- `recoverOrphans` is `UPDATE brain_queue SET status='pending', started_at=NULL WHERE status='running'`, returning `changes`.

- [ ] **Step 4: Run to verify pass. Step 5: Commit.**

---

### Task 2: The drain worker

**Files:**
- Modify: `electron/services/brain/queue.ts`
- Modify: `electron/__tests__/brain-queue.test.ts`

**Interfaces:**

```ts
export const BRAIN_AUTO_INDEX_SETTING_KEY = 'brain.autoIndex';   // default 'false'
export const BRAIN_QUEUE_PAUSED_SETTING_KEY = 'brain.queuePaused';

export interface WorkerDeps {
  store: BrainQueueStore;
  /** Plan 4a's method. Every drain goes through it. */
  indexSource(accountId: number, itemKey: string): Promise<{ skipped: boolean; reason: string }>;
  /** True while any interactive session exists. See the constraint above. */
  hasActiveSession(): boolean;
  isPaused(): boolean;
  /** Injected in tests so no timer runs. */
  scheduleNext?(fn: () => void, ms: number): void;
}

export interface BrainQueueWorker {
  /** Drain until empty, yielding as required. Safe to call repeatedly. */
  drain(): Promise<void>;
  /** The entry being worked on right now, for the operational pane. */
  current(): QueueEntry | null;
  running(): boolean;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
  it('drains pending entries one at a time through indexSource');
  it('does nothing while an interactive session is active', () => {
    // Spec §11: indexing must never compete with the user for rate limit.
    // Assert indexSource was never called, and that the entry is STILL
    // pending afterwards — yielding must not consume the item.
  });
  it('resumes once the active session ends');
  it('does nothing while paused');
  it('marks an entry failed when indexSource rejects, and moves on', () => {
    // Two entries, first rejects. Assert the second still ran: a failed item
    // never blocks the queue.
  });
  it('records a skipped result as done rather than failed', () => {
    // indexSource resolves `skipped` for a gate rejection or an unchanged
    // item. That is a completed unit of work, not a failure — recording it as
    // failed would fill the operational pane with red for normal operation.
  });
  it('never runs two drains concurrently', () => {
    // Calling drain() twice must not double-claim. Concurrency 1 is the whole
    // contract with the user's rate limit.
  });
  it('exposes the current entry while working and null when idle');
  it('stops cleanly on an empty queue without scheduling anything');
```

- [ ] **Step 2–4: Verify failure, implement, verify pass.**

The loop: while not paused, not `hasActiveSession()`, and `claimNext()` returns an entry — `await indexSource(...)`, then `complete()` (including for `skipped`) or `fail()` on rejection. A module-level `draining` flag guards re-entry. The worker never throws; an unexpected error fails the entry and continues.

- [ ] **Step 5: Commit.**

---

### Task 3: Enqueue on session close, and backfill

**Files:**
- Modify: `electron/services/brain/registry.ts`, `electron/main.ts`
- Modify: `electron/__tests__/brain-session-source.test.ts`

**Interfaces:** on `BrainService` —

```ts
  enqueueSource(accountId: number, itemKey: string): void;
  /** Enqueue every admitted, not-yet-indexed item for an account. Returns the count. */
  backfill(accountId: number): Promise<number>;
  queueCounts(accountId?: number): QueueCounts;
  queueList(accountId: number, limit?: number): QueueEntry[];
  drainQueue(): Promise<void>;
```

- [ ] **Step 1: Write the failing tests**

```ts
  it('backfill enqueues admitted items and skips gate-rejected ones');
  it('backfill skips items already indexed and unchanged', () => {
    // The revised estimate assumes this: re-running backfill after a partial
    // run must cost only what is left, not another full pass.
  });
  it('backfill only touches the account it was given', () => {
    // Isolation again: enqueuing a work transcript under the personal account
    // would index it through the wrong subscription.
  });
  it('enqueueSource refuses an item owned by another account');
```

- [ ] **Step 2–4: Verify failure, implement, verify pass.**

In `main.ts`, extend the existing on-close callback at :664. Read the setting **fresh on every close** so a toggle in Settings takes effect without a restart — the same pattern the summary hook beside it already uses and documents:

```ts
      // Brain auto-index. Off by default; the user opts in once. Read fresh so
      // a Settings flip applies without a restart, matching the summary hook
      // directly above. Fire-and-forget: session teardown must never wait on
      // indexing, and the Brain is auxiliary.
      if (db.getSetting(BRAIN_AUTO_INDEX_SETTING_KEY) === 'true') {
        const account = accountsService.getAccountByConfigDir(configDir);
        if (account) {
          brainService?.enqueueSource(account.id, sessionId);
          void brainService?.drainQueue();
        }
      }
```

`getAccountByConfigDir` rather than `resolve()` — ownership from where the transcript lives (spec §4), and it is the same rule the session source already applies.

Also call `recoverOrphans()` once during service construction, and log the count when non-zero.

- [ ] **Step 5: Commit.**

---

### Task 4: IPC and the operational pane

**Files:**
- Modify: `electron/ipc/channels.ts` (`brain_queue_counts`, `brain_queue_list`, `brain_backfill`, `brain_queue_drain`, `brain_queue_clear`, in sorted position — the IPC test asserts a sorted channel list)
- Modify: `electron/ipc/brain-handlers.ts`, `src/lib/api.ts`
- Create: `src/components/brain/BrainQueuePanel.tsx`
- Modify: `src/components/brain/BrainSources.tsx` (mount the panel above the list)

The pane, per spec §14: queue depth by status, the current item, failed items **with their errors**, and controls — Backfill, Drain now, Pause, and the auto-index toggle. Every count is for the selected account only.

- [ ] **Step 1: Write the failing tests**, backend and frontend. Writes (`brain_backfill`, `brain_queue_drain`, `brain_queue_clear`) throw when the service is unavailable; reads degrade. Frontend: counts render, a failed item shows its error, Backfill calls through and refreshes, and the pane shows nothing actionable when no account is selected.

- [ ] **Step 2–4: Verify failure, implement, verify pass. Step 5: Commit.**

---

### Task 5: Verification

- [ ] **Step 1:** `npm run check`, `npm run build`, `npm run test:coverage` (confirm `queue.ts` clears 80% lines), `npm run rebuild:electron`.

- [ ] **Step 2: Drive it for real.** Launch the app, open Brain → Sources, press Backfill on one account, and watch the queue drain. Confirm: depth decreases, the current item updates, starting an interactive session pauses the drain, and ending it resumes.

- [ ] **Step 3: Read the notes the backfill produced.** This is the first time the vault fills up unattended. Check for near-duplicate entities across sessions — `merge()` dedups by note path, so a renamed entity becomes a second note rather than an update, and that is the failure mode to watch at volume.

- [ ] **Step 4:** Record findings in the follow-ups doc, commit, and finish the branch with superpowers:finishing-a-development-branch.

## Self-Review

**Spec coverage.** §11 queue (persistent, concurrency 1, restart survival, yields to interactive sessions, pausable, kill switch) → Tasks 1–4. §14's operational surface (depth, current item, failed items with validation errors, Index-now, pause, kill switch) → Task 4, closing the deferral recorded at the end of Plan 2. §8's "a failed item never blocks the queue" → Tasks 1 and 2.

**Not covered, on purpose:** §10 curation (step 7), §13 MCP server and §15 `/recall` (step 5), §5's repo-artifact and auto-memory adapters (step 6).

**Type consistency.** `QueueEntry` / `QueueCounts` / `QueueStatus` are defined in Task 1 and used by name in Tasks 2–4. `indexSource`'s signature is Plan 4a's, unchanged. The two setting keys are defined in Task 2 and read in Task 3.

**Known gap.** Task 4's test bodies are described rather than written out, unlike Tasks 1–2. That is a deliberate shortcut for same-session execution where the tests get written test-first anyway; expand them before handing this plan to anyone else.
