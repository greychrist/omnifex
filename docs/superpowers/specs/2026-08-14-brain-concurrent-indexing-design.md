# Brain Plan 8 — concurrent indexing, a spend ledger, and visible progress

**Date:** 2026-08-14
**Status:** approved
**Parent spec:** `docs/superpowers/specs/2026-08-11-brain-memory-vault-design.md`
(§11 queue, §14 Brain tab)

## Problem

The Brain indexes only when the user is not working, and spends money nobody
can account for.

Three observations, all verified against the running install:

**The queue is stalled.** 165 items pending on this machine — 84 auto-memory,
69 session, 8 repo, 1 curation — because `brain.queuePaused` is `true` and,
even unpaused, the worker yields whenever any session tab is open anywhere in
the app (`main.ts:532`, `queue.ts:263`). The only drain trigger is session
close (`main.ts:799-819`). There is no timer. So a backlog that yields once is
not retried until the next session closes with no other tab open — which, for a
user who keeps tabs open, is approximately never.

**The spend is invisible where it matters.** `extract.ts:152` documents that
the shared `claude -p` runner "pins a stable scratch cwd and sweeps the
throwaway JSONL the CLI writes." The user's monthly cost report
(`~/Repos/work/management/scripts/ai-cost-report.py`) prices tokens by globbing
`*.jsonl` under each config dir's `projects/`. Swept transcripts are invisible
to it, so **every Brain run to date is missing from the 2026-06, 2026-07 and
2026-08 reports.** OmniFex holds the authoritative figure — `brain_sources.cost_usd`,
taken from the CLI's own `total_cost_usd` rather than a pricing table
(`database.ts:71-74`) — but only as a per-item snapshot that re-indexing
overwrites. There is no ledger, so there is no month-by-month anything.

**Background indexing has no display.** `BrainRun` was deliberately moved into
the main process so a run survives the pane unmounting (`registry.ts:215-227`),
and `brain-run-progress` is broadcast to every window (`main.ts:542`,
`channels.ts:305`). But only `indexSelection` — the manual "Index All" path —
ever sets it. `drainQueue` sets nothing. Background indexing is invisible by
construction, and there is no indicator anywhere outside the Brain tab.

## Decisions

| Question | Decision |
|---|---|
| Yield policy | **Removed.** The queue drains regardless of open sessions. The per-item guard (`liveSessionIds`, `main.ts:536`) already refuses transcripts still being written, which is the only exclusion that was ever load-bearing. |
| What replaces it as a brake | Rate-limit backoff, which does not exist today and becomes a prerequisite rather than a follow-up. |
| Drain trigger | Session close, as now, **plus a periodic sweep**. Without a timer the backlog never moves. |
| Spend record | A new append-only `brain_spend` table. Not `session_cost_daily`, and not `brain_sources`. |
| Who reads it for monthly reporting | `ai-cost-report.py`, gaining SQLite as a second source. That change is work-side and out of scope here; this spec's obligation is to make the data exist and be queryable. |
| Progress | `drainQueue` publishes `BrainRun` exactly as `indexSelection` does, and a global indicator subscribes to the existing broadcast. |
| Curation | Same policy as indexing. One worker, concurrency 1, one rule. |

### Why the yield rule goes rather than getting smarter

The obvious refinement — yield only while a turn is actually in flight — is not
available. `listInFlightTabIds()` is hardcoded to `return []`
(`sessions/lifecycle.ts`, dead since the jsonl-as-rendered refactor), and
`docs/session-lifecycle.md` names depending on it as an anti-pattern. So the
choice is between "any tab open" and "no gate at all". "Any tab open" is wrong
by a wide margin: a tab is open for hours, and spends rate limit for seconds of
it. A work tab open should not stall the personal queue at all, since rate
limit is per account and these are different subscriptions.

That leaves no gate — which is only safe because the thing it was guarding
against gets a real mechanism instead of a proxy for one.

### Why rate-limit backoff is a prerequisite

The parent spec's error table promises "rate limit hit while indexing → back
off, pause the queue, surface it." It was never built; `queue.ts` mentions rate
limit only in comments. Today that is harmless, because the queue only runs when
the user is away and a stalled backlog is the worst case. Remove the gate and
the failure mode changes: indexing burns limit mid-turn, on the account the user
is actively working in. Shipping concurrency without backoff would trade a
stalled queue for a stolen session.

### Why a new table rather than `session_cost_daily`

`session_cost_daily` (`database.ts:503`) has the right column shape and is
already swept hourly by `costHistoryService`. It is still the wrong home:

- Its primary key is `(session_id, date, model)`. A Brain item key for a session
  source **is** a session UUID, so indexing session `abc` on the same day its own
  cost row lands, at the same model, collides. Fixing that means adding a
  discriminator to the PK, and SQLite cannot alter a primary key — it means
  rebuilding a table that currently works.
- Rows there are an *upsert to a daily total*. Brain spend is not a daily total:
  re-indexing an item is new money on top of old money, and a table whose grain
  is "latest value for this day" cannot represent that without the writer doing
  read-modify-write arithmetic it can get wrong.
- Mixing them means every consumer must filter, and a consumer that forgets
  double-counts. A separate table cannot be double-counted by accident.

So: append-only, one row per model-backed run, aggregated by `SUM` at read time.
Re-indexing appends a second row and the month is correct with no arithmetic.

`session_cost_daily` splits cache writes into 5m and 1h buckets. `RunCost` does
not — the CLI envelope the Brain reads reports one `cacheCreationTokens` figure.
The ledger stores the four fields the Brain actually has rather than inventing a
split, and records `NULL` where the CLI said nothing, per the existing rule that
absent must degrade to unknown and never to zero.

## Design

### 1. The gate comes out

`QueueWorkerDeps.hasActiveSession`, the `HasActiveSession` type, the check at
`queue.ts:263`, and `DrainOutcome`'s `'session-active'` reason are all deleted,
along with the branch in `BrainQueuePanel` that renders it. Per the repo's
refactor rule, a defensive branch made unreachable by a change is removed in
that change.

`liveSessionIds` stays exactly as it is. It is the guard that was doing real
work: it keeps the indexer off transcripts still being appended to, which would
otherwise distil half a conversation and record it as finished.

`brain.queuePaused` stays as the manual kill switch. Removing the automatic
gate does not remove the user's ability to stop it.

### 2. Rate-limit backoff

A pure predicate, `isRateLimitError(message: string): boolean`, matching the
shapes the CLI actually produces: `rate limit`, `usage limit`, `429`, and
`quota`, case-insensitively. Pure and exhaustively testable, which is the whole
reason it is a function and not an inline regex.

When `process(entry)` rejects and the message matches:

- The entry is **returned to pending**, not failed. A rate limit is not a
  property of the item, and recording it as a failure would make the user clear
  a red row that named the wrong problem.
- The drain stops and returns `reason: 'rate-limited'`.
- A cooldown timestamp is set. Subsequent `drain()` calls return
  `'rate-limited'` without claiming an entry until it passes.

Cooldown is 15 minutes, in memory. In memory because a restart is already a
signal that the user wants something to happen, and persisting a cooldown means
an app that refuses to index after a restart for reasons the user cannot see.

`DrainOutcome` gains `'rate-limited'` and a `retryAt` field so the panel can say
when it will resume rather than only that it stopped.

### 3. `brain_spend` — the ledger

New migration. Append-only; nothing updates or deletes a row.

```sql
CREATE TABLE brain_spend (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id            INTEGER NOT NULL,
  account_name          TEXT NOT NULL,
  -- 'index' | 'curation'. What the money bought, so a report can separate
  -- extraction from the pass that rewrites notes at a better model.
  kind                  TEXT NOT NULL,
  source_id             TEXT,
  item_key              TEXT NOT NULL,
  model                 TEXT NOT NULL,
  -- Local date, YYYY-MM-DD. Stored alongside the instant because every
  -- consumer groups by month in the user's own timezone, and deriving that
  -- from a UTC instant at read time is where off-by-one-day bugs live.
  date                  TEXT NOT NULL,
  spent_at              TEXT NOT NULL,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_read_tokens     INTEGER,
  cache_creation_tokens INTEGER,
  cost_usd              REAL
);
CREATE INDEX idx_brain_spend_date ON brain_spend(date);
CREATE INDEX idx_brain_spend_account_date ON brain_spend(account_name, date);
```

Written from `electron/services/brain/spend.ts` — `createBrainSpendStore(db)`
with `record(entry)`, `byMonth(month)` and `total(accountId?)`. The registry
calls `record` at each of the two sites that spend: the extraction path (where
`sourceState.record(..., { run })` already receives a `RunCost`) and the
curation path.

`stats.spentUsd` is repointed at `SUM(cost_usd)` over this table rather than
over `brain_sources`. The old figure understated every re-indexed item, because
the snapshot column had already been overwritten by the newest run.

`kind` exists so a report can answer "what did curation cost me" separately.
Curation is pinned to a better model on purpose (`curation.ts:39`), so it is the
line item most likely to surprise, and a total that blends it with Sonnet
extraction hides that.

### 4. Progress from the queue

The registry's `process` dispatch sets `activeRun` around each entry and calls
`publishRun()`, exactly as `indexSelection` does. `total` is computed per entry
as `completed + 1 + pending remaining` — self-correcting, and it needs no
drain-start hook to be right when items are enqueued mid-drain.

`activeRun` remains one at a time across all accounts, matching the worker's
concurrency-1 contract. A manual `indexSelection` during a background drain is
refused by the existing guard, which is the correct answer and already has the
right error message.

### 5. The global indicator

A small component in the titlebar, subscribed to `brain-run-progress` and
reading `brain_current_run` on mount so re-entry mid-run is correct immediately
rather than at the next frame. It shows item N of M and the account, and is
absent when nothing is running.

`BrainRun` is per-account. With the gate gone and two vaults enqueued, runs
still serialize, so the indicator displays one at a time and names which vault
it belongs to.

## Error handling

The governing rule is unchanged: **the Brain is auxiliary.** Nothing here may
break a session.

| Failure | Behaviour |
|---|---|
| Rate limit while indexing | Entry returned to pending, drain stops, 15-minute cooldown, `reason: 'rate-limited'` with `retryAt` surfaced in the panel. |
| Item fails for any other reason | Unchanged: recorded against the entry, never blocks the queue. |
| Spend ledger write fails | Logged and swallowed. Losing an accounting row must not lose the note the money already bought. |
| Periodic drain fires while one is running | The worker's existing re-entry guard returns immediately. |
| A run is in flight when the app quits | `activeRun` is not persisted, by design. `recoverOrphans()` resets the queue row; the next listing reads the truth off `brain_sources`. |

## Testing

Failing test first; 80% lines on backend.

- `isRateLimitError` — every matching shape, and the near-misses that must not
  match (a note whose text contains "rate limit", an error about a rate-limited
  HTTP client in user code).
- Worker: a rate-limit rejection leaves the entry **pending**, not failed;
  the drain stops; a second drain inside the cooldown claims nothing; a drain
  after it resumes. And that a non-rate-limit failure still fails the entry.
- Worker: drains with a session open, since that is the behaviour change — the
  test that would have failed before this plan.
- `brain_spend`: append semantics (two runs on one item on one day sum, not
  replace), month grouping across a month boundary in local time, null token
  fields preserved as null, `kind` separation.
- `stats.spentUsd` reads the ledger and reports the sum of both runs on a
  re-indexed item, where the old snapshot reported only the last.
- Registry: a queue drain publishes `BrainRun` frames with a correct `total`
  when items are enqueued mid-drain.

**Not unit-testable:** whether the CLI's rate-limit message shape changes.
Mitigated by the predicate being one function with one test file, so a new shape
is one line.

**Verification gate** (cross-cutting): `npm run check`, `npm run build`,
`npm run test:coverage`, then `npm run rebuild:electron`.

## Out of scope

Changes to `ai-cost-report.py` — work-side, and it belongs to a `claude-work`
session. This spec's obligation ends at making `brain_spend` exist, be correct,
and be queryable from outside OmniFex.

Also out: a spend ceiling that auto-pauses, per-turn in-flight detection
(blocked on `listInFlightTabIds` being dead), and MCP injection into agent runs.
