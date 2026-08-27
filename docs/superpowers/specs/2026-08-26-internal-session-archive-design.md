# Retaining OmniFex's own model usage

**Status:** proposed
**Date:** 2026-08-26
**Supersedes:** the sweep behaviour documented in `electron/services/sessions/summary-query.ts`
**Related:** `2026-08-26-cost-report-page-design.md`, `2026-08-11-brain-memory-vault-design.md`

## Problem

OmniFex spends real money on the user's account through the Claude CLI, then
deletes the evidence.

Three sites run `runCliOnce` from `sessions/summary-query.ts`:

| Site | Model | What it pays for |
|---|---|---|
| `sessions-summary.ts` | Haiku 4.5 | Session titles/summaries for the sessions page |
| `brain/extract.ts` | Sonnet 5 | Brain indexing |
| `brain/curation.ts` | Opus 5 | Brain curation (pinned to a better model on purpose) |

Two more spawn the CLI with `projectPath: os.tmpdir()` for a catalog
handshake and should produce no billable turn: `models.ts`,
`commands-catalog.ts`. They are in scope for verification only.

Every one of these pins cwd to `<os.tmpdir()>/omnifex-summary-scratch`, lets
the CLI write a transcript into `<configDir>/projects/<encoded-scratch>/`,
and then `rm -rf`s that directory.

### The sweep is a race, and the cost table has the scars

The sweep runs after each call; the cost watcher is also watching that
directory. Whether a given internal transcript is priced depends on which
wins. The Work account currently holds **$37.78** of scratch-derived cost
(2026-06-17 → 2026-08-27) — not zero, not complete. Non-deterministic
accounting is worse than either extreme, because it looks like data.

### It cost us a real investigation

Reconciling August against the Anthropic console, the Work account showed
$906.10 locally against $993.67 for Claude Code. Ruling out the swept spend
took the whole investigation: rates were verified against the pricing page,
the record count was proven complete (6,639 = 6,639), `inference_geo`, fast
mode, web-search charges and long-context premiums were each measured and
excluded. Retained transcripts would have answered it in one query.

### `CLAUDE.md` is currently wrong

> Extraction transcripts are swept, so nothing else on the machine can see
> this spend.

382 of them are sitting in the scratch directory right now. Either the sweep
is failing or it runs late; either way the doc asserts an invariant the code
does not hold. This spec removes the sweep, so the sentence must go.

## Decisions

Settled with Greg before drafting:

1. **Location** — OmniFex's own `userData`, not the Claude config dir.
2. **Reporting** — folded into the totals like any other spend, attributed to
   OmniFex internal, with per-kind line items. The stated goal: *totals should
   match real account spend as closely as possible.*
3. **Retention** — age cap (default 90 days, configurable) plus a manual Clear.
4. **Ledger** — one accounting path. See "The `brain_spend` question" below.

## Design

### Archive layout

```
<userData>/internal-sessions/
  <accountName>/
    <kind>/                       # session-summarization | brain-index | brain-curation
      2026-08-26/
        <cliSessionId>.jsonl
```

`userData` is `~/Library/Application Support/OmniFex/`. Date-partitioned
because pruning is by age, and a directory-level `rm` is cheaper and far
safer than reading timestamps out of thousands of files.

Account name comes from the `configDir` the run was launched with — the same
ownership-by-location rule the Brain uses. It is never inferred from
`resolve()`.

### Writer

`runCliOnce` gains one responsibility: after the CLI exits, **move** the
transcript out of `<configDir>/projects/<encoded-scratch>/` into the archive
instead of deleting it. The scratch projects directory is still emptied, so
nothing accumulates where the CLI put it.

The caller passes its `kind`. That is the only signature change, and it is
required — a run that cannot say what it paid for cannot be attributed, and
the Brain's schema already refuses `'unknown'` for exactly this reason.

Move, not copy: two copies of a billable transcript on disk is how
double-counting starts.

**The move must not be able to lose money.** Order is: move → verify the
destination exists → only then clear the scratch directory. A failed move
leaves the transcript where the CLI wrote it; the next sweep retries. A
crash mid-move costs a stale scratch file, never a deleted one.

### Ingest and attribution

`backfill` gains the archive as a second scan root alongside
`<configDir>/projects`. Same parser, same pricing, same `replaceSession`
idempotency — the transcripts are ordinary CLI JSONL and need no special
handling.

Migration 23 adds a nullable `internal_kind` column to `session_cost_daily`.
`NULL` means a real user session, so every existing row and every existing
query keeps its current meaning.

`project_path` is set to a display label — `OmniFex/Session summarization`,
`OmniFex/Brain index`, `OmniFex/Brain curation`. `shortProject()` already
renders the last two segments, so these read correctly in every existing
table with no change to the renderer.

Consequences, stated plainly because the decision was "match real spend":

- Headline totals **go up** by whatever OmniFex itself spends. That is the
  point — they will sit closer to the console.
- The by-project table gains up to three rows that are not projects. That is
  the cost of one accounting path, and it was accepted deliberately.
- `is_subagent` is orthogonal and unaffected. Internal runs are main-loop.

### Retention

- Setting `internal.archive.retentionDays`, default **90**, `0` = keep forever.
- Prune on the existing background timer: drop whole date directories older
  than the cap.
- **Pruning never touches `session_cost_daily`.** Verified: `replaceSession`
  deletes only the session it replaces, and `backfill` only visits transcripts
  it finds. A pruned transcript's cost rows survive, including across a
  Rescan. This is what makes a single accounting path safe with a finite
  archive, and it is the property most worth a regression test.
- A **Clear internal transcripts** button in Settings, showing current size and
  file count, with a confirm. Same guarantee: cost history is unaffected.

### The Brain must keep excluding these

`brain/sources/session-transcripts.ts` excludes the scratch directory by
name via the exported `SCRATCH_DIR_NAME`. That exclusion now has to cover the
archive root as well. Indexing our own extraction transcripts would be a
feedback loop: the Brain would distil its own distillations, and pay to do it.

This is the single most important line in the change to get right, and it
deserves a test that fails loudly rather than a comment.

## The `brain_spend` question

`brain_spend` was append-only because swept transcripts made it the only
record: a snapshot column (`brain_sources.cost_usd`) is overwritten on
re-index, so money genuinely spent would disappear from the total.

Retaining transcripts removes that premise. Each run leaves its own file
under its own CLI session id, so a re-index produces a *second* set of cost
rows rather than overwriting the first. The append-only property is preserved
by the archive's structure instead of by a dedicated table.

**Decision: the Cost Report reads only `session_cost_daily`.**

`brain_spend` keeps being written, but is demoted to an audit record — it is
what the Brain tab's own spend display reads, and it is the reconciliation
check against the cost table. It is not summed into any report total. Nothing
is counted twice because only one path feeds reporting.

Reasons not to delete it outright:

- It holds the only record of pre-change Brain spend, when transcripts were
  actually being swept.
- It survives archive pruning, so it remains the long-horizon record if the
  retention cap is ever set aggressively.
- Deleting a working append-only ledger to save one table is not a win.

## Historical data

Pre-change history is not fully recoverable, and the spec should not pretend
otherwise.

- **Brain spend** is exactly known from `brain_spend`. A one-time migration
  deletes the racy scratch-derived rows and inserts authoritative daily rows
  from the ledger, tagged with the right `internal_kind`.
- **Session summarization spend** before the change is **lost** — those transcripts
  were deleted and nothing else recorded them. The migration does not invent
  a figure for it.

The Cost Report should note that internal attribution begins on the changeover
date, so a month-over-month comparison across that boundary is not read as a
spending increase.

## Testing

- `runCliOnce` archives rather than deletes; the destination path carries
  account, kind and date.
- A failed move leaves the source intact and writes nothing to the archive.
- `backfill` prices archive transcripts and stamps `internal_kind`.
- Existing rows keep `internal_kind` NULL and every existing query is unchanged.
- **Pruning a date directory leaves `session_cost_daily` untouched, before and
  after a Rescan.**
- **The Brain's session source skips the archive root**, including nested
  date directories.
- Migration 23 is idempotent and safe on a partial schema image (migration 22's
  documented trap: guard on a `sqlite_master` existence check).
- The one-time history migration is idempotent — running it twice must not
  double the Brain rows.

## Risks

- **Totals will change.** Every historical figure shifts once internal spend is
  folded in. Intended, but it will look like a regression to anyone who has
  memorised a number.
- **Archive growth.** Small per file, but the Brain indexes continuously; the
  90-day cap and the size readout in Settings exist for this.
- **Attribution depends on the caller passing `kind` honestly.** A future
  fourth caller that forgets will land unattributed. Making `kind` required
  rather than optional is the mitigation.

## Out of scope

- The remaining console gap (~$36 Sonnet, ~6% Opus in August). This change
  makes future gaps diagnosable; it does not explain past ones, which point
  off-machine.
- `models.ts` / `commands-catalog.ts` catalog handshakes. Verify they produce
  no billable turn; if they do, they get a `kind` and join the archive.
