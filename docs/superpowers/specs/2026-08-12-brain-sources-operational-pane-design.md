# Brain Sources — the operational pane

**Date:** 2026-08-12
**Parent spec:** `docs/superpowers/specs/2026-08-11-brain-memory-vault-design.md` (§14 Brain tab)

`BrainSources.tsx:16` says of itself: *"It is NOT the operational pane from spec §14 — queue depth, Index-now, ..."*. This spec makes it that pane.

## Motivation, from use

The first real backfill exposed every gap at once. The user selected one session, pressed **Drain now**, and the worker began indexing all 158 queued items at ~21.5s each — roughly an hour of unrequested Sonnet spend — with no progress display, no indication anything was happening, and a success message (`drain finished`) printed instantly regardless of outcome. It was stopped four items in, from outside the app.

Every defect below is one of those failures:

| Observed | Cause |
|---|---|
| A per-item selection did nothing | `Drain now` is a global queue control with no notion of selection |
| No sign anything was running | The panel reads counts once per action; there is no polling and no progress |
| "drain finished" while nothing drained | The message is printed unconditionally, even when the worker yields immediately |
| Temp projects indexed anyway | Nothing can exclude a project, and Auto-index runs on session close |
| Could not stop it from the UI | Pause is a checkbox in a settings row, not an obvious control |

## Decisions

| Question | Decision |
|---|---|
| `Drain now` | Renamed **`Index All (n)`**, count in the label, confirmed before running. |
| Primary action | **`Index Selected (n)`**, driven by row checkboxes. |
| Stop | One **Pause/Resume** button. The in-flight item completes; the worker halts. |
| Progress | Polled `queueCounts` + `queueCurrent` at 500ms while a run is live. |
| Project exclusion | **Durable per-account**, enforced in discovery — plus a separate transient view filter. |
| Project key | The **encoded** project directory name. Display is best-effort. |
| Layout | A sortable, filterable table with row checkboxes and a select-all. |

## 1. Two concepts that must not blur

**Excluded (durable).** A property of the account. An excluded project drops out of discovery entirely: it never lists, never enqueues, never indexes on session close. This is the only mechanism that keeps a temp project out of the vault while Auto-index is on, which is why it cannot be a view filter.

**Filtered (transient).** Narrows the rows on screen. Resets on reload. Purely visual, and never affects what the Brain will touch.

They are labelled distinctly in the UI ("Excluded projects" is a managed list; the filter lives in the table header) because a user who confuses them will either leak a temp project into the vault or believe they have and not check.

## 2. Exclusion enforcement

Stored as one setting per account, `brain.excludedProjects.<accountId>`, holding a JSON array of encoded project directory names. Consistent with the existing `brain.vault.<accountId>` key rather than introducing a table for a list that is a handful of strings.

One predicate, applied at every entry point rather than at discovery alone:

- `listSources` — excluded rows are omitted (an "include excluded" toggle reveals them for un-excluding)
- `enqueueSource`, `enqueueProjectSources`, `backfill` — refuse to queue
- `indexSource` — returns `skipped` as a backstop, so a project excluded *after* its items were queued still stops

The backstop matters: the queue is durable across restarts, so without it an exclusion added today would not stop work queued yesterday.

**The project key is the encoded directory name** (`-Users-gregorychristie-Repos-personal-WIN`). Plan 6 established that decoding these back to real paths is unreliable — the `wombeats-ios` case decodes wrongly, which is why `repoPathFromTranscripts` reads `cwd` from inside transcripts instead. Exclusion therefore keys on the encoded name, which is exact and stable, and renders a best-effort readable label beside it. Grouping is correct; only the display is approximate.

## 3. The table

Columns: checkbox · project · session · when · size · status.

`SourceSummary` gains `size`, which `SourceItem` already carries and the summary currently drops. Without it a 21MB session is indistinguishable from a 40KB one, and size is the single best predictor of what an index run will cost.

- **Sort** on any column, default `when` descending.
- **Filter** by free text (project + session id), by status (never indexed / indexed / failed / changed since indexed), and by project.
- **Select-all applies to the FILTERED rows**, never the whole corpus. A select-all that silently reaches beyond what is on screen is how the original accident happens again with extra steps.

## 4. Actions and progress

- `Index Selected (n)` — primary; disabled at zero; the count is the confirmation.
- `Index All (n)` — explicit, counted, and confirmed before it runs. This is the control that spent an hour unasked.
- `Pause` / `Resume` — one button whose label follows the state. The in-flight item finishes (~21s) rather than being abandoned: its tokens are already spent, so killing it discards a note that has been paid for.
- Progress — a bar plus `Indexing 4 of 145 · <current item>`.

Progress is **polled**, not evented: `queueCounts` and `queueCurrent` are already on the IPC surface, a poll needs no new channel or preload allow-list entry, and two SQLite counts per second against an hour-long run is not a cost worth engineering around. Polling runs only while a run is live.

`drainQueue` must also stop claiming success it did not achieve. It returns whether it actually drained or yielded, and the UI says which.

## 5. Error handling

| Failure | Behaviour |
|---|---|
| Index All pressed with a session open | The worker yields; the UI says "yielded — a session is open", not "finished". |
| Exclusion added mid-run | Current item completes; the next excluded item is skipped by the backstop. |
| A project with no admitted items | Listed with a zero count; excluding it is still allowed. |
| Poll fails mid-run | Progress freezes and says so; it never reports completion it did not observe. |
| Select-all then filter change | The selection is intersected with the visible rows, so the count in the button always matches what will run. |

## 6. Testing

Renderer tests in `src/components/__tests__/`, backend in `electron/__tests__/`.

- Exclusion is enforced at every one of the five entry points, each pinned separately — a single shared test would pass while four paths leaked.
- The backstop specifically: queue an item, exclude its project, drain, assert `skipped`.
- Select-all covers filtered rows only, and the button count matches the filtered selection after a filter change.
- `Index All` does not run without confirmation.
- Pause/Resume reflects live state rather than a value read once at mount — the stale-read bug already fixed twice in this tab today.
- Progress polling stops when the run ends and does not leak a timer on unmount.
- `drainQueue` reports yielding distinctly from finishing.

**Verification gate:** `npm run check`, `npm run build`, `npm test`, then `npm run rebuild:electron`.

## 7. Build order

Sequenced so the user is unblocked before the larger change lands.

1. **Controls.** Rename to `Index All (n)` with confirmation, Pause/Resume button, honest drain reporting, progress bar and count. No schema change, no new IPC.
2. **Table and exclusion.** `size` on `SourceSummary`, the durable exclusion setting and its five enforcement points, the table with sort/filter/multi-select, the exclusion manager.

## 8. Out of scope

Per-item cancel of an in-flight CLI call · reordering the queue · scheduling · exclusion by glob or by path rule · decoding encoded project names into real paths · a live event channel for progress.
