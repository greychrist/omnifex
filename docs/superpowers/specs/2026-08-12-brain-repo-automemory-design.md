# Brain Plan 6 — repo-artifact and auto-memory adapters

**Date:** 2026-08-12
**Parent spec:** `docs/superpowers/specs/2026-08-11-brain-memory-vault-design.md`
(§4 multi-account ownership, §5 source adapters, build-sequence step 6)

Plans 1–5 built the vault, the tab, the session adapter, the indexing pipeline
and the retrieval surface. Two of the four v1 sources are still missing. This
plan adds them: **auto-memory**, which is ingested with no model at all, and
**repo artifacts**, which are extracted like any other source.

## What the parent spec left undefined

**"Repo artifact" is never defined.** §5 names the adapter and §4 gives it an
ownership rule, but nothing says which files it reads. **Decision: `CLAUDE.md`
and `AGENTS.md` only**, at repo root and nested. They are the highest-signal,
human-curated statement of how a project works; they are small; and every repo
has at most a handful. `README`, `CHANGELOG` and `docs/` are excluded — the
first two are public-facing or generated, and `docs/superpowers/` holds 100KB+
plan files that would dominate the corpus while restating sessions already
indexed.

**Auto-memory's processing is never specified.** §5 lists it as a source and
§1 puts it in `Notes/`, but the pipeline it goes through is left open.
**Decision: deterministic translation, no model.** The rationale is in §2.

## Decisions

| Question | Decision |
|---|---|
| Repo artifacts | `CLAUDE.md` / `AGENTS.md`, root and nested. Extracted like a session. |
| Auto-memory | Translated deterministically into `Notes/`. No model, no tokens. |
| Pipeline seam | `BrainSource` gains an optional `translate()`; a source implements it OR `distill()`. |
| Trigger | Both enqueue on session close for that project, alongside the transcript. |
| Auto-memory note names | The auto-memory slug, kept verbatim as the filename. |
| Repo paths | Read from a transcript's `cwd`, never decoded from the directory name. |

## 1. The pipeline seam

`BrainSource` gains one optional method:

```ts
/**
 * Notes built with no model. A source implements this OR `distill()`.
 * `indexSource` skips extraction entirely when it is present.
 */
translate?(item: SourceItem): Promise<ParsedNote[]>;
```

`indexSource` branches once, after the gate and the change check and before the
extractor. A translating source needs no extractor and no owning-account config
dir, because it spends nothing. Everything downstream is unchanged: per-entity
path resolution, `merge()`, the git commit, the queue, the source-state record.

The alternative — a fake extractor that fills `Extraction`'s `aliases`,
`keywords`, `timelineEntry` and `decisions` with plausible values derived from
nothing — was rejected. It would put invented structure into the same shape the
model's real output uses, which is precisely the confusion the discriminated
`ItemMetadata` was introduced to avoid in Plan 5.

## 2. Auto-memory adapter

`electron/services/brain/sources/auto-memory.ts`, id `auto-memory`.

### Why no model

These files are already what the vault wants. A real one:

```markdown
---
name: project_nodepty_pty_leak
description: Why node-pty is pinned to 1.2.0-beta.13 — fixes a pty leak
metadata:
  type: project
  originSessionId: ff79cd97-3318-4405-abbb-d20398bfc778
---

node-pty is pinned to **1.2.0-beta.13** … **Why:** … **How to apply:** …
Related: [[project_native_module_abi.md]]
```

Frontmatter, a summary line, prose with a stated rationale, and wikilinks —
converged on the same shape independently, as the parent spec's "Ontology"
section already observed. Running 102 of these through Sonnet would spend
tokens to rewrite prose a human curated deliberately, and lose the exact
wording in the process. Extraction earns its cost on a megabyte of transcript;
here it destroys value.

### Discovery and ownership

`<configDir>/projects/<encoded>/memory/*.md` for every account. The owning
account is **the config dir the file lives under**, definitively — the same
rule as transcripts (§4), and for the same reason: it stays correct when path
rules change.

`MEMORY.md` is skipped. It is an index of its siblings, so ingesting it would
duplicate every one of them in one note.

### Translation

| auto-memory | vault note |
|---|---|
| `name` | filename and title, verbatim |
| `description` | `## Summary` |
| `metadata.type` (`user` / `feedback` / `project` / `reference`) | type `Note`, with the original recorded as an alias |
| body | body, verbatim, `[[links]]` untouched |
| — | `sources: ["auto-memory:<encoded>/<file>"]` |
| file mtime | `created` / `updated` |

Landing in `Notes/`, per the parent spec's folder layout.

**The slug stays the filename.** `project_nodepty_pty_leak` is an ugly title,
but `linkMatchesNote` binds a target by final segment with `.md` stripped, so
keeping slugs preserves the existing link graph across all 102 files for free.
Humanising titles would silently break every `[[…]]` in the corpus.

**`metadata.originSessionId` is deliberately NOT added to `sources`.** It is a
real provenance link and it is tempting. But `merge()` dedups by source key, so
a Note claiming `session:ff79cd97` would make a later index of that actual
transcript believe it was already covered, and the session's own note would
never be written. The origin session is recorded in the body's provenance line
instead, where it informs a reader without steering dedup.

### Idempotency

Translation is a pure function of the file, so a second run produces
byte-identical output and `merge()` returns unchanged. Unlike the session and
capture paths, this is provable on real output rather than against a stub —
Plan 4a's lesson (a deterministic stub makes an idempotency test vacuous when
the real dependency is a model) does not apply where there is no model.

## 3. Repo-artifact adapter

`electron/services/brain/sources/repo-artifacts.ts`, id `repo`.

### Finding the repos

Repos are those with a `projects/<encoded>/` directory under some config dir —
"repos you have actually run Claude in", which needs no new setting.

**The encoded directory name cannot be decoded.** The CLI replaces every
non-alphanumeric character with `-`, so `wombeats-ios` and `wombeats/ios`
encode identically; naive decoding of
`-Users-gregorychristie-Repos-personal-wombeats-ios` yields
`/Users/…/wombeats/ios`, which does not exist. The repo path is therefore read
from a **transcript's own `cwd`** — authoritative, and already how
`SessionMetadata.projectPath` is derived. Discovery reads a bounded prefix of
one transcript per project directory and takes the first row carrying `cwd`. A
project directory with no such row is skipped and recorded, never guessed at.

### Ownership

`resolve()` on the repo path — explicit override, then longest path rule, then
`null` (§4). Unresolved means the item is skipped and recorded as
`blocked: no account`. No silent default.

**A known asymmetry, inherited from the parent spec.** Transcripts are owned by
their config dir; repo artifacts by `resolve()`. A repo whose sessions ran
under Work but whose path rule says Personal would put its `CLAUDE.md` in one
vault and its transcripts in another. The current rules (`~/Repos/personal` →
Personal, `~/Repos/work` → Work) make this unreachable today. The spec mandates
the split, so this follows it, and each item records its owning account so a
disagreement is visible in the Sources pane rather than silent.

### Admission and extraction

Admitted when the file is non-empty. Distilled as its contents, truncated at
the existing 8KB ceiling with the existing marker.

`ItemMetadata` gains a third arm:

```ts
| ({ kind: 'artifact' } & { repoPath: string; file: string })
```

and the extraction prompt gains a matching preamble: it is reading a project's
agent-instruction file, not a transcript. That is what lets OmniFex's
`CLAUDE.md` seed `Projects/omnifex` and Subsystem notes for the services it
describes — and seeding the ontology that session notes then merge into is the
actual argument for indexing repo artifacts, since the file itself is already
in the model's context in every session in that repo.

## 4. Trigger

`main.ts`'s `onSessionClosed` already receives the session id, project path and
config dir, and already enqueues the transcript. It gains the project's
auto-memory files and repo artifacts alongside it.

Change detection makes the ordinary case a free no-op, and a session close is
exactly when both were most likely just edited — the memory tool writes during
a session, and `CLAUDE.md` is edited in one. Both sources also appear in the
Sources pane for explicit Index and Backfill, like every other source.

## 5. Error handling

Unchanged in shape. The Brain stays auxiliary.

| Failure | Behaviour |
|---|---|
| Memory file with broken frontmatter | Skipped, its parse error visible in the tab. Siblings unaffected. |
| Memory file with no `name` | Falls back to the filename stem, which is what the slug is anyway. |
| Repo path unresolvable to an account | `blocked: no account`, surfaced. Never written to a default vault. |
| Project directory with no `cwd` in any transcript | Skipped with a reason. No guessed path. |
| Repo whose `CLAUDE.md` was deleted | Discovery no longer lists it. The note it produced stays — notes are user data, and a vault is not a mirror. |
| Translation throws for one item | Isolated to that item, recorded `failed`. |

## 6. Testing

Failing test first; 80% lines on backend.

- **Isolation, two vaults in one test.** A personal memory file never produces a
  write outside the personal vault. Same shape as Plans 1 and 5, because this
  is again the property whose failure is a confidentiality breach.
- **Translation is pure, so it carries the heaviest coverage:** the frontmatter
  mapping, wikilink preservation, `MEMORY.md` exclusion, missing `name`,
  malformed frontmatter, and **byte-identical re-translation** — idempotency
  proven on real output rather than a stub.
- **`originSessionId` never reaches `sources`**, pinned by a test, because the
  consequence of regressing it is a session that silently never gets indexed.
- **Repo discovery:** the path comes from a transcript `cwd` and not from the
  directory name — asserted with a fixture whose encoded name decodes wrongly
  (`wombeats-ios`), which is the case that motivated the rule.
- **Ownership:** `resolve()` for artifacts including the unresolved case;
  config-dir ownership for memory files.
- **The `artifact` prompt arm** states repo and file and does not describe
  itself as a session.

Fixtures are redacted copies of real auto-memory files, since the entire
premise is that the format is already what it is.

**Verification gate:** cross-cutting — `npm run check`, `npm run build`,
`npm run test:coverage`, then `npm run rebuild:electron`.

## 7. Out of scope

Curation (Plan 7) · GitHub/Jira adapters · watching files for changes ·
ingesting `docs/`, `README` or `CHANGELOG` · writing anything back into a
Claude config dir, which the Brain never does.
