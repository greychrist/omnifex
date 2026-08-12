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
