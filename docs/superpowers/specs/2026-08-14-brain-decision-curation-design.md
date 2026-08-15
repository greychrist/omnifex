# Brain Plan 9 — curating Decisions

**Date:** 2026-08-14
**Parent spec:** `docs/superpowers/specs/2026-08-11-brain-memory-vault-design.md`
**Amends:** `docs/superpowers/specs/2026-08-12-brain-curation-design.md` (Plan 7)

## Problem

Plan 7 shipped curation against `Timeline` alone. Measured on the live vault
(351 notes, both accounts) that turns out to be the wrong section, for two
independent reasons.

**It almost never fires.** `qualifies()` gates on `Timeline` length, and
`merge()` writes exactly one Timeline entry per indexed source. A note therefore
gains one entry per session. The busiest note in either vault has seven. In a
month of indexing, curation has run once.

**It is aimed at 8% of the bytes.** Section sizes of the three largest notes:

| Section | `OmniFex.md` | `PI-404` | `omnifex-brain.md` |
|---|---:|---:|---:|
| `Key facts` | 14,608 | 10,453 | 9,356 |
| `Decisions` | 3,892 | **10,535** | 4,779 |
| `Connected to` | 2,096 | 1,093 | 1,698 |
| `Timeline` | 2,154 | 2,203 | 1,331 |

Worse, curation's second output — `promotedFacts` — is unioned into `Key facts`,
the largest section. On the two biggest notes the pass is **net-additive**.

`Decisions` is the section that actually accumulates: multiple decisions land
per session against one Timeline entry. Fourteen notes already carry eight or
more, led by `PI-404-dashboard-builder-chrome.md` at **38 decisions against 7
Timeline entries** — the largest note in the vault, 39% of it `Decisions`, which
the Timeline gate can never reach.

## Decisions

| Question | Decision |
|---|---|
| Which section joins Timeline | `Decisions`. Not `Key facts` — see §3. |
| Qualifying | A disjunction: either section over its own threshold qualifies the note. |
| Thresholds | Separate constants from Timeline's. The two sections differ in volume by 3–5x. |
| What collapses | The same deterministic rule: every dated bullet except the newest N. |
| Model calls | One per note, returning prose for both spans. Not two calls. |
| Key facts | Left alone, deliberately. §3 records why. |

## 1. `Decisions` collapses exactly as `Timeline` does

Measured across both vaults: **627 of 627 `Decisions` bullets are date-prefixed**
in `merge()`'s `- **YYYY-MM-DD**: text` form. The section has the same shape as
`Timeline`, so it takes the same deterministic rule and the same load-bearing
guarantee — the fold picks the bullets and computes the span, the model only
writes prose about a span it was handed.

```ts
MIN_DECISION_ENTRIES   = 8
RETAIN_RECENT_DECISIONS = 5
```

Separate from `MIN_TIMELINE_ENTRIES` / `RETAIN_RECENT` rather than shared. The
codebase already argues this case for `CURATION_MODEL` vs `EXTRACTION_MODEL`:
two things with different volume get two constants, because the next reason to
change one will not apply to the other. Decisions accrue 3–5x faster than
Timeline entries, so these will diverge.

## 2. Qualifying becomes a disjunction

`qualifies()` currently requires a `Timeline` section to exist and to be long.
It becomes: **either** `Timeline` has `MIN_TIMELINE_ENTRIES` dated bullets
**or** `Decisions` has `MIN_DECISION_ENTRIES`. The freshness and cooldown
guards are unchanged and still apply to the note as a whole.

The shape guard survives without being written down twice: a translated
auto-memory note has neither section, so both arms are false and it is never
curated — the same outcome Plan 7 got from checking `Timeline` for `undefined`.

The prompt gains a second block, and `CurationResult` a second prose field:

```ts
interface CurationResult {
  collapsed: string;          // the Timeline span
  collapsedDecisions: string; // the Decisions span
  promotedFacts: string[];
}
```

One model call, not two. Volume is not the reason — a note qualifying on both
sections is one Opus call either way, and splitting it would double the cost of
the note that needs curation most while halving the context each call has to
work from.

A section with nothing to collapse is **omitted from the prompt entirely** and
its field is expected to come back empty. Asking a model to summarize an absent
span invites it to invent one.

## 3. `Key facts` is not curated, and this is the reason

`Key facts` is the largest section in the vault and the obvious target. It is
excluded anyway.

**There is no deterministic order to collapse along.** 0 of 1,902 `Key facts`
bullets carry a date. The only ordering available is document order, which
`appendUnique` makes equal to first-seen order — age.

**Age is the wrong axis for a fact.** For `Timeline` and `Decisions`, old means
superseded: that is precisely why collapsing them is safe. For a fact, having
survived many merges without being contradicted is evidence it is *durable*.
"macOS caps ptys at `kern.tty.ptmx_max = 511`" does not go stale. Collapsing
the oldest facts would delete the best-established ones first.

**The operation that would actually help is semantic deduplication**, and it
cannot be made deterministic. Deciding that six bullets say the same thing is
exactly the judgement Plan 7 §1 refuses to give the model, on evidence — zod
validates shape, not truth, and curation is the pass that destroys.

So `Key facts` growth stays unsolved and is stated as such rather than papered
over. Two directions worth exploring later, neither cheap:

- Bound it at the *write* side in `merge()` — refuse a fact that is a
  near-duplicate of an existing one, using a deterministic similarity measure
  rather than a model.
- A model rewrite of a fold-selected window, with the fold enforcing that the
  output is strictly shorter and fewer, accepting that this is shape validation
  and weaker than the Timeline guarantee.

Until one lands, `BODY_SECTION_PRIORITY` in `mcp-tools.ts` is what keeps
`Key facts` from costing retrieval: the search path now serves the section in
part, capped, rather than serving a note whole.

## 4. Ordering the run

`enqueueCuration` sorts candidates by `collapsibleEntries(note).length`. It
becomes the sum of both collapsible sets, so the note with 38 decisions and 7
Timeline entries sorts above one with 9 and 9. Ties still break on path, so a
run stays deterministic.

## 5. Cost

Fourteen notes qualify immediately, `MAX_NOTES_PER_RUN` caps a run at 8, and the
single curation run to date cost $0.11. Clearing the current backlog is roughly
**$1.50 across two runs** — against $30.01 of indexing spend. The cooldown and
the freshness guard keep the steady state far below that.
