# Brain Plan 7 — curation and vault statistics

**Date:** 2026-08-12
**Parent spec:** `docs/superpowers/specs/2026-08-11-brain-memory-vault-design.md`
(§2 note format, §10 curation, §11 queue, §14 Brain tab, build-sequence step 7)

Plans 1–6 built the vault, the tab, four source adapters, the extraction and
merge pipeline, the queue worker and the retrieval surface. Every write path so
far only ever **adds**: `merge()` appends Timeline entries, unions aliases,
keywords and Key facts, and never removes anything. Notes therefore grow without
bound, and because `/recall` and the MCP `brain_read` tool pull a whole note body
into the model's context, an old note costs its entire accumulated history on
every retrieval — most of it stale detail already superseded by later entries.

This plan adds the one pass that removes: **curation**, which collapses an old
Timeline into a summary and promotes recurring facts. It also adds the
**statistics** surface that says whether curation is firing at the right time,
because the parent spec's qualifying threshold was inherited rather than
measured.

## What the parent spec left undefined, and where this plan deviates

**§10 says "the one agent-writes-files pass," ported from Rowboat's
`note_curation.ts`.** This plan does not do that. **Decision: structured JSON
plus a pure fold**, the same shape as `extract.ts` + `merge.ts`. The reason is
measured, not stylistic. Plan 4a's live run produced a note asserting internals
that do not exist anywhere in `distill.ts`; Plan 6's produced `keyFacts`
containing `"...wait"` and `"placeholder"`. zod validated both, because zod
checks shape and not truth. An agent writing the file directly has no schema at
all, and curation is the one pass that *destroys* information — the combination
of "unvalidated output" and "irreversible except through git" is the wrong place
to give a model the most freedom. This is the same class of deviation as moving
extraction off §8's pinned Haiku, and it rests on the same kind of evidence.

**§10 says curation "retires stale Open items."** It does not, here.
`merge.ts` treats `Open items` and `Assistant notes` as `HUMAN_SECTIONS` it
never writes, on the stated grounds that overwriting them "would make the tab's
edit box a trap." **Decision: curation writes `Timeline` and `Key facts` only** —
exactly the sections `merge()` already owns. The invariant stays one sentence a
user can hold in their head: *automated writes never touch human sections.*
Retiring Open items is not worth being the exception that requires a footnote.

**§10 describes a "daily curation pass" but names no trigger.**
**Decision: enqueue on session close, behind an opt-in setting defaulting off**,
draining through the existing queue worker. No timer is introduced; the parent
spec's own follow-on list already places cron under a separate Background agents
sub-project.

**§10's qualifying numbers are Rowboat's, and were never checked against this
vault.** They are kept as the v1 defaults, but this plan ships the measurement
that decides whether they are right — see §5.

## Decisions

| Question | Decision |
|---|---|
| Write path | Model returns validated JSON; a pure `curate()` folds it. Never agent-writes-files. |
| Sections written | `Timeline` and `Key facts` only. Human sections are untouchable. |
| What collapses | Decided deterministically by the fold, never by the model. |
| Trigger | Enqueued on session close behind `brain.curate`, default off. |
| Transport | Existing `brain_queue`, via a `curation` sentinel source id. |
| Model | `claude-opus-5`, pinned separately from `EXTRACTION_MODEL`. |
| Inspection | The `Curation` git commit, plus a recently-curated filter in the Brain tab. |
| Threshold | §10's numbers as named constants, retuned from the stats panel's measurement. |

## 1. The model never chooses what to delete

This is the load-bearing rule of the design.

`curate()` decides deterministically which Timeline entries collapse: every
entry except the newest `RETAIN_RECENT`. It computes the collapsed span's date
range itself, from the entries it is collapsing. The model receives only that
span and returns two things — prose summarizing it, and facts recurring across
it that are worth promoting into `Key facts`.

So the model writes sentences. It never picks which history disappears.

This follows the rule extraction already uses (§6: deterministic facts are
*stated*, not requested) and it has a sharper consequence here: the operation
that loses detail is a pure function over its inputs, so it can be tested
exhaustively, while the operation that cannot be tested — the model's judgement
— can only add prose. A model that returns nonsense produces a note with a bad
sentence in it, not a note missing six months of history.

The collapsed entry:

```markdown
## Timeline
- **2026-05-01 – 2026-07-20**: <model prose> _(12 entries collapsed)_
- **2026-08-09**: Fixed the pty leak's second path in terminal mode.
- **2026-08-11**: Moved extraction off Haiku after measured hallucination.
```

The date range and the count are computed by the fold. Only the prose is the
model's.

## 2. `curate.ts` — the pure fold

`merge.ts`'s twin: no I/O, no model, no clock. Two exports.

```ts
qualifies(note: ParsedNote, today: string): boolean
curate(note: ParsedNote, result: CurationResult, opts: { date: string }): ParsedNote
```

`qualifies` is true only when all four hold:

| Guard | Rule |
|---|---|
| Length | `Timeline` has at least `MIN_TIMELINE_ENTRIES` entries. |
| Freshness | `curated_at` is absent, or `updated` is later than it. |
| Cooldown | `curated_at` is absent, or at least `COOLDOWN_DAYS` before `today`. |
| Shape | The note has a `Timeline` section at all. |

The shape guard is what excludes translated auto-memory notes, whose bodies are
`## Summary` plus the original prose and carry no Timeline. Freeform notes are
never curated.

`curate` replaces `Timeline` with the collapsed entry followed by the retained
recent entries, unions the promoted facts into `Key facts` using the same
`union` helper `merge()` uses, stamps `curated_at`, and rewrites the body
through the existing `renderBody` so section order and trailing-newline
behaviour are unchanged. Every other section — `Summary`, `Connected to`,
`Decisions`, `Open items`, `Assistant notes` — is carried through verbatim.

Constants live together in one exported block with their reasoning beside them:

```ts
MIN_TIMELINE_ENTRIES = 8   // §10's number. Retune from the stats panel.
RETAIN_RECENT        = 5
COOLDOWN_DAYS        = 7
MAX_NOTES_PER_RUN    = 8
```

### A curated note cannot immediately re-qualify

Three independent guards, any one of which suffices: the Timeline is now short,
`curated_at` is today so the cooldown blocks it, and `updated` is no longer
later than `curated_at`. Deliberately redundant — the failure this prevents is
an unbounded Opus loop on a single note.

## 3. `curation.ts` — the model side

`extract.ts`'s twin: schema, prompt, pinned model, retry-once runner.

```ts
CurationResultSchema = z.object({
  collapsed: z.string(),
  promotedFacts: z.array(z.string()).default([]),
})
```

`CURATION_MODEL = 'claude-opus-5'`, pinned separately rather than inheriting
`EXTRACTION_MODEL`. Volume is the entire reason extraction is not on Opus —
backfill is ~142 sessions. Curation has no such volume: at most
`MAX_NOTES_PER_RUN` notes per run, behind a cooldown, on notes that have already
accumulated. It is a compression task where a subtle judgement error is durable,
which is where the better model earns its cost. Two tasks with different volume
and different stakes get two constants; the next reason to change one will not
apply to the other.

The prompt states the note's title, type and the span being collapsed, then
lists the entries verbatim, and asks for the two fields. It runs through
`createSummaryQueryRunner()` under the owning account's `CLAUDE_CONFIG_DIR`, as
extraction does. Parse failures raise `CurationParseError` and get exactly one
retry — a transport error propagates unretried, matching `createExtractor`.

## 4. Transport: curation rows in the existing queue

`queue.ts`'s worker dependency changes from `indexSource(accountId, itemKey)` to
`process(entry)`. The worker stops knowing what an item *is*; the registry
supplies the dispatch, keyed on `entry.sourceId`.

A curation row is `(accountId, CURATION_SOURCE_ID, relPath)` — a sentinel source
id that names no adapter, commented as such where it is defined. Everything the
worker already guarantees then applies to curation for free: concurrency 1,
yielding entirely while an interactive session is open, the pause switch, the
kill switch, orphan recovery after a crash, per-item failure isolation, and
visibility in the operational pane. The existing UNIQUE constraint means a note
already pending is not queued twice.

The alternatives were considered and rejected. A separate table and worker would
have to re-implement yielding and pausing, and two independent workers cannot
jointly honour "never compete with the user for rate limit" — that guarantee
only exists if one thing drains. Running inline in `onSessionClosed` would fire
Opus calls with nothing able to pause them, no record of what ran, and would run
precisely when a session was still active.

`BrainService` gains three methods:

```ts
curateNote(accountId: number, relPath: string): Promise<CurateResult>
enqueueCuration(accountId: number): Promise<number>
stats(accountId: number): VaultStats
```

`enqueueCuration` lists notes, reads each, filters through the pure `qualifies`,
sorts by Timeline length descending so the worst offenders go first, and
enqueues at most `MAX_NOTES_PER_RUN`.

`curateNote` **re-runs `qualifies` before spending anything.** A note can change
between enqueue and claim, and Plan 4a's most expensive bug was `indexSource`
ignoring exactly this class of check — every unit test passed while the real
system re-paid for unchanged work. It writes through
`writeNote(..., 'Curation')`, which commits.

## 5. Statistics

The threshold in §2 is inherited. This surface is what replaces it with an
observation, and it answers the standing question of what the Brain costs in
context.

`stats.ts` is pure over `listNotes()` + `readNote()` — no model, no clock. Same
O(vault) scan as `backlinks()`, which the followups doc already accepts at this
size and flags for a link table if a vault reaches thousands.

`VaultStats` carries:

- **Size** — note count, total bytes, counts by note type, median and largest
  note size.
- **Context cost** — estimated tokens for the median and largest note, and for
  the whole vault. Estimated as bytes ÷ 4 and labelled as an estimate in the UI;
  it is a ratio, not a tokenizer, and presenting it as exact would be a lie the
  number cannot support.
- **Timeline distribution** — how many notes fall in 1–3, 4–7, 8–15 and 16+
  entries, plus how many notes qualify right now at the current threshold.

That last figure is the one to read before judging the threshold. If it says 0,
the threshold is theatre; if it says 40, it is too loose. `BrainStatsPanel.tsx`
renders this in the Brain tab beside the queue panel.

## 6. Inspection

Curation runs unattended once opted in, so the audit trail is the deliverable,
not an afterthought.

Every run commits as `Curation` through the existing vault git integration, so
`git log` in the vault is the record and `git revert` is the undo — the property
Plan 1 called "what makes the later curation pass safe," now actually load-
bearing. The Brain tab's note list gains a recently-curated filter, driven by
the `curated_at` frontmatter field that has been in the schema since Plan 1 and
has never had a writer.

A dry-run approval queue was considered and rejected: it is a pending-proposal
store, a diff view and an approval surface that will sit unattended the moment
the novelty wears off, guarding a change that git already makes reversible.

## 7. Error handling

| Failure | Behaviour |
|---|---|
| Unparseable model reply | One retry, then the queue entry fails with the message. **The note is never written** — a failed curation costs tokens, not history. |
| No longer qualifies at claim time | Skipped before spending. Recorded `done`, not `failed`: the queue already treats a skip as completed work, and red rows during normal operation train the user to ignore the pane. |
| Note deleted, or vault unconfigured, between enqueue and claim | Same — skipped, `done`. |
| Note has no Timeline (translated auto-memory) | Never qualifies, so never enqueued. |
| Promoted fact already present | `union` dedups it. |
| Model prose contains `## ` headings | Stripped in the fold. A heading inside a bullet would restructure the note, which is what the structured path exists to prevent. |
| `git commit` fails | Existing `lastGitError` path; `status()` already surfaces it. |
| Anything else thrown | Per-item failure; the queue continues. The parent spec's §8 rule: a failed item never blocks the queue. |

## 8. Testing

Backend tests in `electron/__tests__/`, written first. Coverage target 80%
lines, as for all backend work.

- **`curate()` purity and idempotency** — curating twice with the same result is
  byte-identical; `Open items` and `Assistant notes` survive verbatim; the
  collapsed date range is computed from the entries and not taken from the
  model; `RETAIN_RECENT` entries survive untouched; a model heading is stripped.
- **`qualifies()`** — each of the four guards independently blocks, including a
  freeform note with no Timeline.
- **The re-qualification short-circuit** — a note that changed between enqueue
  and claim spends nothing, asserted by a stub curator that records zero calls.
- **Worker dispatch** — a curation row routes to `curateNote` and a source row
  to `indexSource`; both still yield to an active session and honour pause.
- **`enqueueCuration`** — ordering by Timeline length, the per-run cap, and no
  double-queue of a pending note.
- **`stats()`** — over a fixture vault with known sizes and known Timeline
  lengths.

**The vacuous-stub trap, named explicitly.** Plan 4a proved that a deterministic
stub makes an idempotency test meaningless when the real dependency is a
language model. So the byte-identical claim is pinned on `curate()`, the pure
function, where a stub is not a stand-in for anything. The end-to-end claim is
proved live, not asserted in a unit test.

**Live proof.** Configure a real vault, index enough sources for a note to
genuinely qualify, run one curation at Opus, and record in
`docs/superpowers/plans/2026-08-11-brain-vault-followups.md`: whether the
collapsed prose preserved what mattered, whether the promoted facts were real
and not invented, what the stats panel reports, and what the distribution says
`MIN_TIMELINE_ENTRIES` should actually be. That measurement sets the constant —
the value shipped is a starting point, not a finding.

**Verification gate:** cross-cutting — `npm run check`, `npm run build`,
`npm run test:coverage`, then `npm run rebuild:electron`.

## 9. Out of scope

A dry-run approval queue · a user-facing threshold setting · any timer or cron
trigger · curating freeform notes · writing `Open items` or `Assistant notes` ·
changes to `/recall` or the MCP tools, which read whatever the vault holds ·
a link table for `backlinks()` · GitHub/Jira adapters.
