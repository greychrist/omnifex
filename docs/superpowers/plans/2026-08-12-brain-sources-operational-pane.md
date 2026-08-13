# Brain Sources operational pane — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the Brain Sources pane into the operational surface spec §14 promised — honest progress, a stoppable worker, per-item selection, and durable project exclusion.

**Architecture:** Phase 1 changes only the renderer plus one honest return value from `drainQueue`. Phase 2 adds `size` to `SourceSummary`, a per-account exclusion setting enforced at five entry points, and a sortable/filterable table with multi-select.

**Tech Stack:** Electron main (TypeScript, better-sqlite3), React 18 + Tailwind v4 renderer, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-12-brain-sources-operational-pane-design.md`

## Global Constraints

- **TDD.** Failing test first, watch it fail, then implement.
- Renderer tests in `src/components/__tests__/`, backend in `electron/__tests__/`. Backend coverage target 80% lines.
- Every new invoke channel goes in `electron/ipc/channels.ts`; `ipc-channel-contract.test.ts` enforces a handler exists.
- Strip `undefined` optional params before crossing IPC.
- Handler adapters accept camelCase and snake_case.
- **No state read once at mount that can change.** This tab has already shipped that bug twice today (stats panel, and the Pause checkbox). Controls reflect live state.
- **Selection and counts must never disagree.** Any button that runs work shows the count it will run.
- Work on `feat/brain-sources-pane` in the main checkout. **No worktrees.**
- Verification gate: `npm run check`, `npm run build`, `npm test`, then `npm run rebuild:electron`.

## Verified facts (measured 2026-08-12 — do not re-derive)

- `drainQueue(): Promise<void>` (`registry.ts`) returns nothing; `BrainQueuePanel` prints `'drain finished'` unconditionally, so a yield reads as success.
- The worker yields on `isPaused() || hasActiveSession()` re-checked every iteration (`queue.ts:234`), so a pause takes effect after the current item — measured live: paused mid-run, one in-flight item completed, worker halted.
- Real throughput: **21.5s average per session** across 4 real indexes.
- `BrainQueuePanel` reads `brain.autoIndex` / `brain.queuePaused` / `brain.curate` **once on mount** (`useEffect` with `[]`), which is why a pause applied outside the UI does not show.
- `SourceSummary` (`registry.ts:145`) has `accountId, sourceId, itemKey, label, mtimeMs, admitted, reason, status, changed`. **No `size`.** `SourceItem` has `size`.
- For sessions, `label` is the **encoded** project dir name (`session-transcripts.ts:97`, `label: project.name`).
- OmniFex's own summary-scratch runs are already excluded from discovery via `SCRATCH_DIR_NAME`.
- Per-item indexing already exists: `BrainSources.tsx:157` renders an `Index` button calling `api.brainIndexSource(accountId, selected)`.

---

# Phase 1 — controls (unblocks the user)

## Task 1: `drainQueue` reports what it actually did

**Files:**
- Modify: `electron/services/brain/queue.ts`, `electron/services/brain/registry.ts`, `electron/ipc/brain-handlers.ts`, `src/lib/api.ts`
- Test: `electron/__tests__/brain-queue.test.ts`, `electron/__tests__/brain-curation-registry.test.ts`

**Interfaces:**
- Produces: `interface DrainOutcome { processed: number; yielded: boolean; reason: 'empty' | 'paused' | 'session-active' }`
- `BrainQueueWorker.drain(): Promise<DrainOutcome>`; `BrainService.drainQueue(): Promise<DrainOutcome>`

- [ ] **Step 1: Write the failing tests**

In `brain-queue.test.ts`:

```ts
  it('reports yielding for an open session rather than completion', async () => {
    store.enqueue(accountId, 'session', 'a');
    const { w } = worker({ active: true });
    const out = await w.drain();
    expect(out).toEqual({ processed: 0, yielded: true, reason: 'session-active' });
  });

  it('reports yielding when paused', async () => {
    store.enqueue(accountId, 'session', 'a');
    const { w } = worker({ paused: true });
    expect((await w.drain()).reason).toBe('paused');
  });

  it('reports how many it processed when it runs to empty', async () => {
    store.enqueue(accountId, 'session', 'a');
    store.enqueue(accountId, 'session', 'b');
    const { w } = worker();
    expect(await w.drain()).toEqual({ processed: 2, yielded: false, reason: 'empty' });
  });

  it('counts a failed item as processed', async () => {
    store.enqueue(accountId, 'session', 'bad');
    const { w } = worker({ result: () => Promise.reject(new Error('boom')) });
    expect((await w.drain()).processed).toBe(1);
  });
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test -- electron/__tests__/brain-queue.test.ts` — expect failures on `undefined` vs the object.

- [ ] **Step 3: Implement**

In `queue.ts`, `drain()` tracks `processed` and returns the outcome. The re-entrancy guard returns `{ processed: 0, yielded: true, reason: 'paused' }` — a concurrent drain is not a completion.

```ts
export interface DrainOutcome {
  processed: number;
  yielded: boolean;
  reason: 'empty' | 'paused' | 'session-active';
}
```

Loop shape:

```ts
    let processed = 0;
    for (;;) {
      if (deps.isPaused()) return { processed, yielded: true, reason: 'paused' };
      if (deps.hasActiveSession()) return { processed, yielded: true, reason: 'session-active' };
      const entry = deps.store.claimNext();
      if (!entry) return { processed, yielded: false, reason: 'empty' };
      // ... existing body ...
      processed += 1;
    }
```

`isPaused` and `hasActiveSession` become separate checks so the reason is accurate.

Thread the type through `registry.drainQueue`, the `brain_queue_drain` handler, and `api.brainQueueDrain`.

- [ ] **Step 4: Run the tests, then the suite**

`npm test -- electron/__tests__/brain-queue.test.ts` then `npm test`.

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(brain): drainQueue reports yielding instead of claiming success"
```

## Task 2: live settings, Pause/Resume button, honest messages

**Files:**
- Modify: `src/components/brain/BrainQueuePanel.tsx`
- Test: `src/components/__tests__/BrainQueuePanel.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
  it('renders Pause while running and Resume while paused', async () => {
    vi.mocked(api.getSetting).mockImplementation((k) =>
      Promise.resolve(k === 'brain.queuePaused' ? 'true' : 'false'));
    render(<BrainQueuePanel accountId={1} />);
    await waitFor(() => { expect(screen.getByRole('button', { name: /resume/i })).toBeTruthy(); });
    expect(screen.queryByRole('button', { name: /^pause$/i })).toBeNull();
  });

  it('says it yielded when the worker yielded', async () => {
    vi.mocked(api.brainQueueDrain).mockResolvedValue(
      { processed: 0, yielded: true, reason: 'session-active' });
    render(<BrainQueuePanel accountId={1} />);
    fireEvent.click(await screen.findByRole('button', { name: /index all/i }));
    // confirm dialog, then:
    await waitFor(() => { expect(screen.getByText(/session is open/i)).toBeTruthy(); });
  });

  it('labels Index All with the pending count', async () => {
    vi.mocked(api.brainQueueCounts).mockResolvedValue({ pending: 154, running: 0, done: 4, failed: 0 });
    render(<BrainQueuePanel accountId={1} />);
    await waitFor(() => { expect(screen.getByRole('button', { name: /index all \(154\)/i })).toBeTruthy(); });
  });

  it('does not run Index All without confirmation', async () => {
    render(<BrainQueuePanel accountId={1} />);
    fireEvent.click(await screen.findByRole('button', { name: /index all/i }));
    expect(api.brainQueueDrain).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement**

- Rename the `Drain now` button to `Index All ({counts.pending})`, gated behind an inline confirm (a second click state, `Confirm — index 154?`, rather than a modal; the panel has no dialog today).
- Replace the Pause `SettingSwitch` with a button whose label is `paused ? 'Resume' : 'Pause'`.
- Re-read the three settings whenever the panel refreshes (`nonce`), not only on mount, so an external change shows.
- Map `DrainOutcome` to text: `empty` → `indexed N`, `session-active` → `yielded — a session is open`, `paused` → `yielded — the queue is paused`.

- [ ] **Step 4: Verify** — `npm test -- src/components/__tests__/BrainQueuePanel.test.tsx`, then `npm run check && npm run build`.

- [ ] **Step 5: Commit**

## Task 3: progress while a run is live

**Files:**
- Modify: `src/components/brain/BrainQueuePanel.tsx`
- Test: `src/components/__tests__/BrainQueuePanel.test.tsx`

- [ ] **Step 1: Failing tests** — while a drain is in flight the panel polls and renders `Indexing 5 of 158`; polling stops when the run ends; no timer leaks on unmount (assert `clearInterval` via fake timers).

- [ ] **Step 2: Watch fail.**

- [ ] **Step 3: Implement** — a `useEffect` that starts a 500ms interval when `busy` is true, calling `api.brainQueueCounts`, and clears it in cleanup. Total = `done + failed + pending + running` captured at start; current = `done + failed + 1`. Render a bar (`<div>` width percentage — no new dependency) plus the text.

- [ ] **Step 4: Verify. Step 5: Commit.**

---

# Phase 2 — table and exclusion

## Task 4: `size` on `SourceSummary`

**Files:** `electron/services/brain/registry.ts`, `src/lib/api.ts`, tests in `brain-registry.test.ts`.

- [ ] Failing test asserting `listSources` returns each item's byte size → implement by carrying `item.size` through → verify → commit.

## Task 5: durable project exclusion

**Files:** `electron/services/brain/registry.ts`, `electron/ipc/channels.ts`, `electron/ipc/brain-handlers.ts`, `src/lib/api.ts`; test `electron/__tests__/brain-exclusions.test.ts`.

**Interfaces:**
```ts
excludedProjects(accountId: number): string[];
setExcludedProjects(accountId: number, labels: string[]): void;
```
Setting key `brain.excludedProjects.<accountId>`, JSON array of encoded dir names.

- [ ] **Failing tests, one per entry point** — `listSources` omits, `enqueueSource` refuses, `enqueueProjectSources` skips, `backfill` skips, and the backstop: enqueue an item, exclude its project, drain, assert `skipped`. Five separate tests; one shared test would pass while four paths leaked.
- [ ] Implement a single `isExcluded(accountId, label)` predicate used at all five.
- [ ] Verify, commit.

## Task 6: the sources table

**Files:** `src/components/brain/BrainSourcesTable.tsx` (new), `src/components/brain/BrainSources.tsx`; test `src/components/__tests__/BrainSourcesTable.test.tsx`.

- [ ] **Failing tests:** sorts on each column; free-text filter matches project and session id; status filter; **select-all selects only filtered rows**; changing the filter intersects the existing selection so the button count always matches what will run; `Index Selected (n)` disabled at zero.
- [ ] Implement as a presentational component taking rows + selection state, so it is testable without IPC.
- [ ] Verify, commit.

## Task 7: the exclusion manager

**Files:** `src/components/brain/BrainProjectFilter.tsx` (new), wired into `BrainSources.tsx`.

- [ ] **Failing tests:** lists every discovered project with a session count; toggling exclude persists via `api.brainSetExcludedProjects`; an excluded project disappears from the table; the "show excluded" toggle reveals it for un-excluding.
- [ ] Implement, verify, commit.

## Task 8: verification and live proof

- [ ] Full gate: `npm run check`, `npm run build`, `npm test`, `npm run rebuild:electron`.
- [ ] Restart the app (main-process code does not hot-reload — this cost an hour of confusion today) and drive it: select two sessions, `Index Selected (2)`, watch progress, pause mid-run, resume, exclude a temp project and confirm it vanishes and stays out after a session closes in it.
- [ ] Record findings in `docs/superpowers/plans/2026-08-11-brain-vault-followups.md`.

## Self-review

**Spec coverage:** §1 two concepts → Tasks 5 and 7. §2 enforcement at five points → Task 5. §3 table → Tasks 4 and 6. §4 actions and progress → Tasks 1–3. §5 error handling → the yield reason (Task 1), the backstop (Task 5), selection/filter intersection (Task 6). §6 testing → each task's tests. §7 build order → phases.

**Placeholders:** none. Every task names its files, its interface, and its tests.

**Type consistency:** `DrainOutcome` is defined once in `queue.ts` and threaded through `registry` → handler → `api`. `excludedProjects`/`setExcludedProjects` use the same names in service, handler and renderer. The exclusion key is the encoded `label` everywhere.
