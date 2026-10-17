# Brain: query-aware excerpts for over-cap search hits

Status: approved 2026-10-17. Scope: `electron/services/brain/mcp-tools.ts`
(`condenseBody`, `attachBodies`) and `fts-query.ts` (a term extractor). No index,
schema, `merge.ts` or instructions change.

## Problem

`brain_search` attaches each hit's body, capped at `MAX_BODY_CHARS` (2,000).
An over-cap note is condensed by `condenseBody`, which picks sections in a
fixed priority (Summary, Key facts, Decisions, Timeline, …) and then spends the
remainder on the *leading* lines of the first section that did not fit.

The choice ignores the query. On the large notes — the ones that need
condensing at all — Key facts runs to dozens or hundreds of bullets, and the
bullet that matched is usually not among the first few. Observed 2026-10-16: a
search returned four notes, each as Summary plus the opening Key facts and
"_(97 more in this section)_", ~3K tokens with nothing bearing on the query.

XERJ (`xerj-common/src/xccode/passage.rs`) makes the same point about code:
returning the head of a file instead of the densest span "was the single worst
bug this tool had." The Brain already avoids a raw head slice; this makes the
section and line choice query-aware.

## Design

1. **Terms.** `queryTerms(query)` in `fts-query.ts` reuses the FTS tokenizer
   (`TOKEN`, keyword filter) so the excerpt matches what the index matched on:
   lowercased, deduplicated, length ≥ 2.
2. **Line match.** A line matches when its lowercase text contains a term, or
   the term with one common inflection removed (`-ing`, `-ed`, `-es`, `-s`,
   stem ≥ 4 chars). The index uses Porter; this is a cheap approximation, and
   the cost of a miss is only today's behaviour.
3. **Section order.** Summary first, always — it orients the reader. Then
   sections containing a matching line, in the existing priority order, then
   the rest. `Connected to` stays excluded even when it matches: wikilinks are
   navigation.
4. **Whole-section pass.** As today, greedily keep whole sections in that
   order — except that the first *matching* section that does not fit stops
   the pass and becomes the partial section. Otherwise a non-matching section
   further down could take the budget the match needed.
5. **Partial section.** Spend the remaining budget on matching lines first,
   then leading non-matching lines, and render the chosen lines in their
   original order (Timeline and Decisions are chronological). The footer
   reads `_(N more in this section)_`, plus `; lines matching the query kept`
   when the chosen lines are not simply a leading prefix — the model should
   know it is reading a selection, not the top of the section.
6. **No terms or no match** yields exactly today's output.

Invariants unchanged: body ≤ cap, omitted sections named in the footer,
partial section never listed as omitted, verbatim body when it fits, prefix
fallback for heading-less notes.

## Measuring it

It is not ranking, so it does not wait on the retrieval eval harness. Count,
over `brain_search` calls in transcripts, the share of truncated bodies
containing at least one query term — before and after.
