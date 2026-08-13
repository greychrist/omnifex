# Brain vault foundation — deferred follow-ups

**Date:** 2026-08-11
**Context:** Recorded at the end of the `feat/brain-vault-foundation` branch's
final whole-branch review (verdict: MERGE WITH FIXES). This is the durable
record of everything deferred out of that review — the execution workspace it
was tracked in is being deleted, so anything not written here is lost.

> **Status update (Plan 2, `feat/brain-tab`).** Every item in the "Required
> before Plan 2" section below is now CLOSED, along with the `toFtsQuery`
> length cap from the second section — the Brain tab ships a search box, which
> was that item's stated trigger. What remains open is listed under
> "Still open" at the end of this document. The sections below are kept as the
> record of what was wrong and why it mattered.

## Required before Plan 2 (the Brain tab) ships — ALL CLOSED

- **No `rebuild(accountId)`, `deleteNote(accountId, relPath)`, or non-creating
  vault-status probe on `BrainService` / IPC.** `VaultIndex.rebuild()` and
  `.remove()` already exist in `electron/services/brain/search.ts` and are
  tested, but nothing in `electron/services/brain/registry.ts` or
  `electron/ipc/brain-handlers.ts` calls them — they are unreachable from the
  service and from IPC. Consequence: pointing Brain at an existing Obsidian
  vault indexes nothing, ever; editing a note in Obsidian never reaches the
  index; and the spec's error-handling row "FTS index corrupt or stale ->
  rebuild from the vault" has no code path that implements it. This is the
  branch's largest functional gap — "Plan 2 is pure UI" is not true until
  this is closed.

- **The same status probe also resolves two other deferred items:**
  distinguishing "never configured" from "configured but missing" (the
  contradiction fixed in the spec's error-handling table by this review —
  `open()` lazily creates a vault at a stale path, so it cannot itself answer
  "does this exist?"), and warning before reassigning a non-empty vault to
  another account. There is currently no way to detect "non-empty" at all,
  because `brain_list_notes` requires the vault to already be configured for
  the account attempting the reassignment.

- **Hard-linked `.md` note bypasses vault containment.** A note at
  `<work-vault>/Subsystems/X.md` hard-linked to
  `<personal-vault>/Subsystems/Secret.md` passes `vault.ts`'s realpath-based
  `safeJoin`, because a hard link has no distinct realpath from its target —
  both names resolve to the same inode, and `safeJoin` only checks that the
  resolved path lands inside the vault root, not that the entry has exactly
  one name. `readNote` on the work-vault path returns the personal vault's
  body, and `writeNote` truncates the shared inode, corrupting both accounts'
  copies simultaneously. Fix by applying the same `nlink > 1` rejection
  `registry.ts`'s `ensureVaultIndexPath` already applies to the index
  directory, but to note files in `vault.ts`. Owner-deferred as safe to carry
  while nothing on this branch has a UI that lets a user point a vault at an
  arbitrary pre-existing directory.

- **Symlinked `.git` lets one vault's commits land in another account's
  history.** `<work-vault>/.git` symlinked to `<personal-vault>/.git` makes
  git resolve the personal account's object database while using the work
  vault's working tree, so every `commitAll` from the work account appends
  the work note bodies into the personal account's git history — durable and
  cumulative, and undetectable from either vault's own directory listing.
  Not reachable through any API surfaced on this branch today (no UI lets a
  user create or repoint a vault to collide this way). Same deferral
  rationale as the hard-linked note above.

- **`commitAll` failures are completely silent.** `createVaultGit(...).commitAll()`
  (`electron/services/brain/git.ts`) collapses both "git binary missing" and
  "nothing to commit" into a bare `return false`, and every call site
  (`registry.ts`'s `writeNote`) passes that result straight to
  `fireAndLogGitFailure`, which only logs on a REJECTED promise — a resolved
  `false` is treated as a normal, silent outcome. A persistently failing
  commit (corrupt `.git`, permissions issue, disk full) therefore produces no
  log, no error, and no visible signal anywhere. Fix this before any UI
  claims to surface git/versioning status for a vault — right now that status
  would be fiction.

## Worth doing, not urgent (see "Still open" below for current status)

- **Extract `walkToRealAncestor(path, realpathFn)`** shared by
  `paths.ts`'s `canonicalPath` and `vault.ts`'s `safeJoin` — both walk up to
  the deepest existing ancestor and re-append the non-existent tail before
  resolving. Share only the walking MECHANISM, not the semantics: the two
  callers deliberately use different realpath functions —
  `canonicalPath` uses `realpathSync.native` to case-fold for cross-account
  identity comparison, while `safeJoin` uses plain `realpathSync` consistently
  on both sides of its containment check. Do this as its own commit, gated by
  the existing test suites for both functions — no new tests should be
  needed if the refactor is behavior-preserving.

- **Thread the injectable `ExecGit` from `createBrainService` through to
  `createVaultGit`** (`registry.ts` around line 316). `createVaultGit` already
  accepts an injectable exec; `createBrainService` doesn't take or forward
  one. Doing so would make the background `git init` fired on vault open
  trackable/awaitable rather than fire-and-forget, and would make Plan 2's
  tests deterministic instead of racing test cleanup against an untracked
  child process (see the retry-with-backoff cleanup workaround already in
  `brain-registry.test.ts`'s `afterEach`).

- **Lift `'.omnifex'` to a shared constant.** It is currently spelled out
  independently in three places: `vault.ts`'s `EXCLUDED_DIRS`, `vault.ts`'s
  `.gitignore` template content, and `registry.ts`'s `INDEX_DIR`. A future
  edit to one spelling without the other two would silently start committing
  the derived FTS index (including full note bodies) into the vault's git
  history.

- **Add a length cap to `toFtsQuery` input.** A very long search query builds
  a correspondingly large FTS5 `MATCH` expression; `registry.search()` only
  catches `VaultConflictError` and lets everything else propagate, so a
  pathological query would surface as a raw SQLite error rejecting the IPC
  call rather than a clean empty result or user-facing message. Not reachable
  today because nothing calls `search` from user input yet — becomes
  reachable the moment the Brain tab or `/recall` ships a search box.

- **`BrainNote.frontmatter.type` in `src/lib/api.ts` is typed `string`**, but
  the backend (`electron/services/brain/types.ts`) already has a real union
  (`'Project' | 'Subsystem' | 'Topic' | 'Session' | 'Note'`). Narrow the
  renderer type to match so the Brain tab gets exhaustiveness checking on
  note-type switches instead of a bare string.

- **Two tests in `brain-registry.test.ts` self-skip on case-sensitive
  filesystems via an early `return`** (`'rejects a case-variant path on a
  case-insensitive filesystem'` and its siblings using the
  `if (!existsSync(...)) return;` pattern). An early `return` reports as a
  passing test without asserting anything, which is indistinguishable from a
  real pass in CI output. Switch these to `ctx.skip()` (vitest's context-based
  skip) so a case-sensitive CI runner reports them as explicitly skipped
  rather than silently green.

---

## Still open after Plan 2 (`feat/brain-tab`, 2026-08-11)

Everything under "Required before Plan 2" is closed, as is the `toFtsQuery`
length cap. These remain:

- **Extract `walkToRealAncestor(path, realpathFn)`** — unchanged from above.
  Still purely a de-duplication, still gated by the two existing suites.

- ~~**Thread the injectable `ExecGit` from `createBrainService` through to
  `createVaultGit`.**~~ **CLOSED in Plan 3** (`feat/brain-session-adapter`).
  `createBrainService(db, { execGit })` now forwards the runner, and
  `VaultHandle` carries a `gitReady` promise that resolves when the init has
  settled (never rejects — a rejection would surface as an unhandled rejection
  in every call site that stores a handle without awaiting). Both
  `brain-ipc.test.ts` and `brain-registry.test.ts` inject a stub exec and their
  retry-and-swallow `afterEach` blocks are gone.

- **Lift `'.omnifex'` to a shared constant** — unchanged. Note that `'.git'`
  now has the same shape: `GIT_DIR` in `registry.ts` and the literal in
  `vault.ts`'s `EXCLUDED_DIRS`. Fold both into one move.

- **Two tests in `brain-registry.test.ts` self-skip via an early `return`** —
  unchanged; switch to `ctx.skip()`.

- **`parseWikilinks` exists twice on purpose.** `electron/services/brain/links.ts`
  and `src/lib/brainWikilinks.ts` are twins across the process boundary, since
  the renderer cannot import from `electron/`. Both carry a comment naming the
  other and both are tested over the same nine cases, so a drift shows up as a
  red suite rather than silently. If a third consumer appears, that is the
  moment to introduce a shared module — not a third copy.

- **The Brain tab has no operational pane** — queue depth, current item, failed
  items, Index-now, pause, kill switch. Spec §14 places these in this tab, but
  the queue has no worker until Plan 4, so an operations panel over a table
  nothing drains would be a control surface for nothing. It lands with the
  worker. This is a deliberate deferral, not an oversight.

- **The tab cannot create notes.** `updateNoteBody` is read-modify-write by
  design and refuses to create. Explicit capture ships in Plan 5 alongside
  `brain_remember`; until then the tab edits and deletes what the vault
  already holds.

- **`backlinks()` reads every note in the vault on each note open.** Correct
  by construction (the FTS index is stemmed and limited, so narrowing through
  it would silently miss links) and fine for the hundreds-of-files case, but
  it is O(vault) per navigation. If a vault ever reaches the thousands, add a
  link table maintained on write rather than weakening the scan.

---

## Opened by Plan 7 (`feat/brain-curation`, 2026-08-12)

**One real curation at Opus, and it is worth its token.** A note with 12
Timeline entries drawn from this document's own history, curated through the
live CLI at `claude-opus-5`: **7 entries collapsed into one, 5 retained, in
11 seconds.** Every factual claim in the collapsed prose checks out, including
which fix caused which — it correctly attributed the Haiku→Sonnet move to the
measured `distill.ts` hallucination rather than to cost, and correctly recorded
that Opus was rejected on volume.

Three things went better than expected:

- **The promoted facts are real, and one of them is a correction.** Among the
  five promoted was `The distiller reads session transcripts only — it does not
  read git diffs.` The source entry recorded that Haiku *hallucinated* that
  claim; the model promoted the refutation, not the hallucination. Compare Plan
  4a and Plan 6, where model output had to be caught inventing things — this run
  had the opposite failure mode available to it and did not take it.
- **The human sections survived byte-identical.** `Open items` and
  `Assistant notes` came through untouched, as did `Summary`, `Connected to`
  and `Decisions`.
- **11 seconds, against ~2.5 minutes for one extraction.** Curation reads a
  handful of bullets rather than a truncated megabyte, so the Opus pin costs
  far less wall-clock than the Sonnet extraction pin does. The volume argument
  that kept extraction off Opus does not transfer.

**The measurement that was supposed to set the threshold could NOT be taken,
and `MIN_TIMELINE_ENTRIES = 8` therefore ships unmeasured.** This is the one
open item from this plan and it is deliberate, not an oversight.

- The free half was measured. Translating the real auto-memory corpus into a
  throwaway vault (86 discovered, **83 admitted, 110ms, no model, no tokens**)
  gives the first real context-cost figures: **83 notes, 144 KB,
  ~37k estimated tokens for the whole vault, ~402 tokens for the median note,
  ~1,389 for the largest** (`Notes/project_win_production_standup.md`).
- The half that sets the threshold was not. All 83 landed in the `none`
  Timeline bucket and `qualifyingCount` was **0** — correctly, because
  translated auto-memory notes carry no Timeline and are never curated. The
  Timeline distribution only becomes meaningful once **session-extracted** notes
  exist, and that needs a Sonnet backfill (~142 sessions, 30–100 minutes,
  real spend). That is Greg's call, not something to do unattended.
- So: run a session backfill, read the histogram in the stats panel, and set
  `MIN_TIMELINE_ENTRIES` from it. Until then the constant is Rowboat's number
  wearing a comment that says so.

**The `Curation` commit is real but ASYNCHRONOUS, and a naive check will miss
it.** The first live probe read `git log` immediately after `curateNote`
resolved and saw only the seed commit — `commitAndRecord` is `void`-ed
fire-and-forget (`registry.ts:561`), as every other Brain write path is. Waiting
3s showed `b17e8f7 Curation` on top. Nothing is wrong, but the spec's
audit-trail claim cannot be verified by a synchronous read, so it is pinned by a
unit test that asserts on the captured `git commit -q -m Curation` argv instead.

- **A stub `execGit` returning `''` for everything never reaches `git commit`.**
  `commitAll` asks `git status --porcelain` what is staged and returns
  `nothing-to-commit` for an empty answer, so a uniformly-empty stub silently
  proves nothing. The commit-message test returns a non-empty porcelain line for
  `status`. Worth knowing for any future test that asserts on commit behaviour.

**Re-curation is blocked, verified live.** `enqueueCuration` immediately after a
real curation returned **0**. All three guards were independently in force: the
Timeline was down to 6 entries, `curated_at` was today, and `updated`
(2026-08-12) was no longer later than `curated_at` (2026-08-13).

- **`updated` is deliberately NOT bumped by curation**, which is what makes that
  third guard work. Curation is not a source event: `updated` means "the latest
  source this note has seen", and bumping it would both mislabel a compressed
  note as freshly sourced and re-open the note for immediate re-curation.

- **Deviation from spec §6, taken knowingly.** Recently-curated ships as a list
  in the stats panel rather than a filter in the note list. A filter would need
  `curated_at` for every note, which the renderer only has after reading every
  note over IPC; the backend already computes it in one pass for the stats
  panel. Same information, one read instead of N.

- **NOT verified: any of this inside the running app.** Same gap Plans 5 and 6
  both recorded, and for the same reason — the real app database still has no
  vault configured. Everything above ran against throwaway vaults through the
  real CLI. The stats panel, the Auto-curate switch and the manual Curate button
  have unit tests but have never been rendered in the live app.

## Opened by Plan 6 (`feat/brain-repo-automemory`, 2026-08-12)

**The whole auto-memory corpus translated, free.** 86 files discovered under
the personal config dir, 83 admitted, **83 notes written in 99ms with no model
and no tokens**. The second run skipped as unchanged. The three rejects are all
genuine: hand-written files in the WIN memory directory with no frontmatter
fence (`test-data-log.md`, `feedback_no_direct_server_edits.md`,
`production-credentials.md`).

- **The `name:` field is NOT the filename, and using it as one was a bug.**
  Measured: **72 of 90 files have `name:` different from the filename stem** —
  it is often a human sentence (`AWS cost reduction target ~$400/mo`). Two
  consequences, both found by running the real corpus rather than fixtures:
  1. Naming notes after `name` would break four fifths of the corpus's links,
     because memories link each other by FILENAME (`[[project_native_module_abi.md]]`).
  2. A `name` containing `/` became a directory: the first run created
     `Notes/AWS cost reduction target ~$400/mo.md`, i.e. a nested folder inside
     `Notes/`. **This is Plan 4a's lesson recurring at a different boundary** —
     there it was a model-supplied entity name, here a human-written frontmatter
     field. A name that came from outside is never a path. Notes are now named
     after the source file and the human name is kept as an alias.

- **Link matching and entity resolution disagreed about separators, and now do
  not.** `resolve.ts`'s `fold()` collapses `[\s_-]+`, but `linkMatchesNote` only
  lowercased — so the vault treated `foo-bar` and `foo_bar` as one entity but
  two link targets. On the real corpus that cost 5 of 29 links, all hyphenated
  references to underscored filenames. Folding separators in `linkMatchesNote`
  and the renderer's `resolveWikilink` took link binding from **83% to 90%**.
  The remaining 3 are genuinely dangling in the source corpus too
  (`[[tui-control-mirror]]` where the file is `project_tui_control_mirror.md`).
  This was a scope addition, justified by the measurement rather than by taste.

**Repo artifacts: one real extraction, and it is worth its token — with a
caveat.** 8 artifacts discovered across the personal repos. This repo's
`CLAUDE.md` extracted in 18.4s into `Projects/OmniFex.md` whose every factual
claim checks out: the Tauri→Electron migration, node-pty vs child_process, the
no-worktrees rule, the legacy `greychrist` identifiers. Aliases and keywords
are exactly the strings a developer would type.

- **The extraction produced ONE entity, not the Subsystem seeds predicted.**
  The spec argued artifacts would seed `Projects/<repo>` *plus* Subsystem notes.
  In practice it produced the Project note with dangling links to
  `[[Subsystems/omnifex-session-lifecycle]]`, `[[Subsystems/omnifex-permissions]]`
  and `[[Subsystems/omnifex-service-pattern]]`. Dangling links are normal vault
  behaviour and do mark notes worth creating, but the claim was overstated:
  artifacts seed the ONTOLOGY, not the notes.

- **The model left junk in `keyFacts`.** The generated note contains
  `- Legacy identifiers greychrist.db, greychrist://... wait` and
  `- placeholder` — the model apparently thought out loud mid-JSON and left a
  stub behind. zod validated the shape and could not have caught it. Same class
  as Plan 4a's hallucinated internals, and the same mitigation: the Brain tab.
  One sample, so the frequency is unknown; worth watching across a backfill
  before deciding whether it needs more than inspection.

- **`previewSource` now returns `metadata: null` for a translating source**,
  with `notePaths` naming what it would write. Fabricating a distillation shape
  for a source that never distills would have been the same mistake the
  `ItemMetadata` discriminant exists to prevent.

- **`repoPathFromTranscripts` reads a bounded 256KB prefix.** A project
  directory whose transcripts carry no `cwd` in that window is skipped with a
  reason rather than guessed at. Not observed on the real corpus, but a very
  long tool-only prologue could in principle trip it.

- **NOT verified: the close-time trigger in the running app.** The
  `enqueueProjectSources` path is unit-tested and wired into `onSessionClosed`,
  but the live app still has no vault configured, so it has never fired for
  real. Same gap Plan 5 recorded.

## Opened by Plan 5 (`feat/brain-mcp-recall`, 2026-08-12)

**The MCP server is proven against a packaged build, not a dev bundle.** Driven
through a real MCP stdio handshake with the SDK's own client against
`out/OmniFex-darwin-arm64/OmniFex.app`: `tools/list` returned all three tools,
`brain_search` returned a ranked hit with a snippet, `brain_read` returned
frontmatter and body, `brain_read` on `../escape.md` came back `isError` with
"path escapes the vault root", and `brain_remember` wrote a capture. That run
exercised Electron-as-node with `better-sqlite3` on the Electron ABI, which is
the combination no unit test can reach.

**The capture round trip is proven with the real model.** One
`brain_remember` about the node-pty pin, through discovery, the gate, a live
Sonnet extraction and `merge()`, produced `Subsystems/node-pty.md` with
`sources: [capture:cap-e2e-1]`, aliases and keywords a developer would type,
and every factual claim correct. A second `indexSource` spent nothing
(`unchanged since it was last indexed`), the note was findable through the
read-only index the MCP server uses, and the capture file survived as
provenance.

- **`mcpServers` in `settings.json` was dead, and OmniFex has been writing
  there.** Claude Code reads user-scope MCP servers from
  `<configDir>/.claude.json`; the only MCP keys `settings.json` honours govern
  APPROVAL of servers defined elsewhere. So every server added through
  OmniFex's MCP manager tab has been silently ignored by the CLI for as long as
  that tab has existed. Fixed in this branch. No migration shipped: neither
  config dir had a stranded block, verified immediately before the change.

- **Measured against CLI 2.1.228, so later versions are worth re-checking.**
  `--mcp-config` loads on a fresh spawn AND on `--resume`; it MERGES rather
  than replacing (all 12 of the user's other servers stayed loaded);
  `--allowedTools` merges with the account's `settings.json` rules rather than
  replacing them. `claude mcp list` rejects `--mcp-config`, so it cannot be
  used to probe. The spawn-time path depends on all three of these.

- **A latent packaging trap, currently unreachable.** The bundled MCP SDK
  contains `require("ajv/dist/runtime/...")` calls, and forge ships only the
  explicitly copied native modules — `ajv` is not in the package. Those
  requires sit in ajv's generated-validator path, used for raw JSON-Schema tool
  definitions; all three Brain tools use zod, so nothing reaches them. Define a
  future tool with a JSON Schema and the packaged server dies with
  `Cannot find module 'ajv/...'` while the dev build works. One
  `copyNativeModule(buildPath, 'ajv')` line in `forge.config.ts` closes it.

- **`useAccounts` threw outside its provider and nearly coupled the prompt
  input to it.** `/recall` needs the session's account, and reaching for
  `useAccounts()` in `FloatingPromptInput` broke every test that renders it
  bare — and would have crashed any future non-provider mount. Added
  `useOptionalAccounts()`. The rule generalises: a feature that is enrichment
  must degrade when its context is absent, not take the host down with it.

- **A rejected `brain_remember` deliberately does not consume an id.** Ids are
  the capture's `itemKey`, so a gap would read as a lost capture in the queue.
  A test pins this.

- **NOT yet verified: the in-app live round trip.** The real app database has
  no vault configured (`brain_queue` and `brain_sources` are both empty), so
  everything above ran against throwaway vaults. Configuring a vault in the
  Brain tab and opening a session under that account is the remaining step —
  and the one question no test can answer is whether the model reaches for
  `brain_search` on its own, since nothing auto-injects the Brain into a
  session's context. If it does not, the tool description is the lever.

- **The Brain tab still has no view of captures as a distinct kind.** They
  appear in the Sources pane beside session transcripts, with a capture-shaped
  metadata table, but there is no filter for them. Fine at a handful; worth
  revisiting if explicit capture becomes a habit.

## Opened by Plan 4b (`feat/brain-queue`, 2026-08-12)

**The worker is proven end-to-end.** Two real sessions drained through the live
pipeline: with a session marked active both stayed `pending` and nothing was
consumed; with it inactive both completed, 0 failed, 63.2s for two items
(~31s each, so ~77 personal sessions is roughly 40 minutes — consistent with
the 30–100 minute estimate).

- ~~**Near-duplicate entities.**~~ **FIXED.** Two sessions about the same work
  produced `Subsystems/Brain memory vault.md` *and*
  `Subsystems/omnifex-brain-vault.md` — one subsystem, two notes, because
  `merge()` dedups by note path. Fixed with both available levers:
  `resolve.ts` matches a new entity's name and aliases against existing notes'
  titles and aliases (case- and separator-insensitive, never on substrings, so
  `Brain` does not collapse into `Brain memory vault`), and the extraction
  prompt now lists the vault's existing entity names so the model converges on
  one in the first place. Re-verified live on the exact pair that failed: the
  second session merged into the first note, both session keys are in
  `sources`, the Timeline has both entries, and `omnifex-brain-vault` survives
  as an alias.

  Note the residual risk: over-matching would silently lose one entity inside
  another's note, which is worse than a duplicate. That is why matching is
  deliberately conservative and a test pins `Brain` staying separate from
  `Brain memory vault`.

- **`updated` could precede `created`, and backfill would have made it the
  norm.** Discovery sorts newest-first, so an older session merges into a note
  a newer one created on essentially every backfill step. `merge()` took
  `provenance.date` verbatim, so a note created 2026-08-12 ended up stamped
  `updated: 2026-08-11` — and across a full run most notes would have reported
  the OLDEST session they saw as their last touch. Now `created` is the
  earliest date the note has seen and `updated` the latest; both stay pure
  functions of their inputs, so idempotency is unaffected.

- **`listInFlightTabIds` is dead and the worker must never use it.** It is
  hardcoded to `return []` (`sessions/lifecycle.ts:511`) since the
  jsonl-as-rendered refactor, and `docs/session-lifecycle.md` names relying on
  it as an anti-pattern. A worker gated on it would never yield — it would run
  hardest exactly when the user is working. The queue uses `listActiveTabIds`.
  Worth noting that `docs/session-lifecycle.md:139` already flagged this and
  the TODO to wire the renderer's derived count into the installer gate is
  still open; anything else that needs a real in-flight signal in main has the
  same problem.

- **The summary hook's early return was load-bearing and is now a branch.**
  `main.ts`'s `onSessionClosed` previously did `if (!enabled || !autoOn)
  return;`. Since both close-time consumers share that one callback, leaving
  the early return would have silently disabled Brain auto-indexing for anyone
  who has session summaries turned off.

- **Auto-indexing ships off by default** (`brain.autoIndex`), with its opt-in
  toggle and the pause switch in the Brain tab's queue panel alongside
  Backfill / Drain now / Clear finished. Spec §14 puts the kill switch in
  Settings; it is here instead because every other operational control already
  is, and splitting them would mean hunting in two places to stop indexing.
  Both switches are global rather than per account, and are read once on mount
  rather than per account change so the UI does not imply a scoping they do
  not have.

## Opened by Plan 4a (`feat/brain-extract-merge`, 2026-08-12)

**First real extraction, measured.** One session (`27b32dad`, 4 prompts / 53
replies, 1.99MB raw) through the live CLI at Haiku into a throwaway vault:
5 notes written, 1 git commit, and a second run produced **no** commit and
byte-identical files — the end-to-end idempotency property, proven on real
output rather than on `merge()`'s return value.

**Extraction moved off Haiku to Sonnet 5 (2026-08-12).** A deliberate deviation
from spec §8's Haiku pin, on the evidence below. Opus was rejected on volume:
backfill is ~142 sessions. Re-running the SAME session at Sonnet produced
notes whose every factual claim checked out against the code, including
correctly recording which of the session's own bugs were fixed and which were
still open at the moment the transcript was captured.

**The model change surfaced two real defects that stub-based tests could not.**

1. **A model-supplied entity name is untrusted input for a filesystem path.**
   Sonnet returned an entity *named* `Projects/omnifex` — it generalized the
   prompt's folder-qualified `links.target` shape to `name`. `vault.notePath`
   rejects separators, and that exception escaped `indexSource` and killed the
   whole item. Fixed twice over: the zod schema normalizes a name to its last
   path segment (consistent with how `linkMatchesNote` already resolves
   wikilinks), and `indexSource` now isolates per-entity failures so one
   unusable entity costs that entity rather than the four good notes beside it.

2. **`indexSource` ignored `hasChanged()`.** Re-indexing re-called the model,
   and a non-deterministic model returns different prose, so the second run
   rewrote the note — end-to-end idempotency was `false` on real output while
   every unit test passed, because the tests use a *stub* extractor that
   returns the same thing twice. The change-detection store Plan 3 built for
   exactly this was never wired in. `indexSource` now stops before spending
   anything when an item is already `indexed` and unchanged, with a `force`
   option for a deliberate redo. Re-verified live: second run is a free no-op
   and the bytes are identical.

   **The lesson generalizes:** a deterministic stub makes an idempotency test
   vacuous when the real dependency is a language model. Plan 4b's worker will
   re-run over items repeatedly and needs this same guard on every path.

- **Haiku hallucinates implementation detail it cannot see.** The generated
  `Subsystems/Distiller.md` says the distiller "detects file changes from git
  diffs" and parses "decision/fact blocks from prose patterns". Neither exists;
  `distill.ts` does nothing of the kind. The model was working from a truncated
  tail of a session about the distiller and invented plausible internals. This
  is the failure mode the Brain tab exists to catch, and it is not fixable by
  validation — zod checks shape, not truth.

- **It also conflates similar numbers.** The corpus has both "77 personal
  sessions" and "142 of 185 admitted (77%)". The generated notes report
  "77 admitted (77% final pass rate)" and "77 real sessions (19%)", mixing the
  two. Numbers in extracted notes should be treated as untrusted.

- **Bare wikilinks resolve, so this is NOT a problem.** The prompt asks for
  folder-qualified targets (`Projects/omnifex`) and the model emitted bare ones
  (`[[Brain]]`, `[[Omnifex]]`). `linkMatchesNote` compares last segments
  case-insensitively, so these bind correctly; `[[Omnifex]]` is simply a
  dangling link to a note that does not exist yet, which is normal vault
  behaviour and marks a note worth creating.

- **Aliases and keywords are good** — the part spec §2 calls load-bearing.
  Generated keyword lists are literal identifiers a developer would actually
  type (`distill.ts`, `createSummaryQueryRunner`, `turnDelta.ts`,
  `session-transcripts.ts`), not descriptions. FTS should work well on these.

- **Entity carve-up is arbitrary but defensible.** One session produced
  `Brain`, `Distiller`, `Session Discovery & Filtering`, `Extraction & Merge
  Pipeline` and a `Prompt-Preserving Truncation` topic. Reasonable, though a
  different run would likely split differently — worth watching for whether
  re-indexing related sessions converges on stable names or spawns near-
  duplicates. `merge()` dedups by note path, so a renamed entity becomes a
  second note rather than an update.

- **Cost and latency.** One extraction took ~2.5 minutes wall-clock for a 1.99MB
  transcript (dominated by the CLI call, not distillation). At 142 sessions
  that is roughly six hours of serial indexing, which materially shapes Plan
  4b's worker: it needs to be interruptible and to yield to interactive
  sessions, not merely "concurrency 1".

## Opened by Plan 3 (`feat/brain-session-adapter`, 2026-08-12)

- **Oldest-first truncation can drop every user prompt.** Verified against a
  real 1.06MB transcript: 2 prompts and 18 assistant replies distilled to
  7.9KB, and the surviving tail was assistant prose only — the user's original
  ask was elided. Spec §6 specifies oldest-first, and this implementation
  follows it, but prompts are the most information-dense rows in a transcript
  and losing all of them makes a note describe what was said without what was
  asked. Plan 4 should decide whether the extractor gets a prompt-preserving
  budget (e.g. keep every `USER:` chunk, spend the remaining budget on the
  assistant tail) before it starts writing notes from these.

- **`listSources` and `previewSource` each call `discover()`**, which walks
  every account's projects tree. Fine at hundreds of sessions on a warm page
  cache — the Sources pane is a deliberate, low-frequency action — but a config
  dir holding thousands would feel it, and `previewSource` re-walks purely to
  re-find one item. Cache the discovery result per call if it starts to matter.

- **The `.summary.json` sidecars beside each transcript are ignored.** They are
  already-generated prose about the same session, so Plan 4 may want them as
  extractor input rather than re-deriving. Deliberately out of scope here:
  they are optional, model-generated, and this step spends no tokens.

- **Gate precision, measured on the real corpus (2026-08-12).** Run across both
  live config dirs: **185 transcripts discovered** (77 personal, 108 work),
  **142 admitted (77%)**, 43 skipped — 42 for "fewer than 2 prompts", 1 for "no
  assistant prose". No startup-error skips fired. Median admitted transcript is
  1.4MB, so essentially every admitted session will hit the 8KB ceiling and be
  truncated, which is what makes the truncation item above the pressing one.
  Whether 77% is the right admission rate is a judgement to make after Plan 4
  produces notes from these; spec §7 already names the remedy if it is too
  loose (an LLM classifier behind the same `admit()` call).

- **Both discovery exclusions are load-bearing, confirmed by count.** The
  personal config dir holds 401 `.jsonl` files; only 199 are top-level session
  transcripts (202 live in `<sessionId>/subagents/`), and **122 of those 199
  are OmniFex's own summary-scratch runs**. 77 remain, matching discovery
  exactly. Without the scratch exclusion, 61% of what the Brain indexed from
  that account would have been OmniFex talking to itself.

- **`isPromptRow` in `distill.ts` is a twin of `src/lib/jsonlClassifier.ts`.**
  The renderer's version is authoritative but unimportable from `electron/`
  (it uses the `@/` alias, which `tsconfig.electron.json` does not define).
  Same arrangement as `links.ts` / `brainWikilinks.ts`, but weaker: these two
  are NOT tested over a shared case list, so a CLI change to how a prompt row
  is marked would be caught in one and missed in the other. Worth a shared
  fixture if a third consumer appears.
