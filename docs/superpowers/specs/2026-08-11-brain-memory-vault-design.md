# The Brain — a memory vault for OmniFex

**Date:** 2026-08-11
**Status:** approved

## Problem

OmniFex has no memory. Every session starts from zero: the same constraints get
rediscovered, the same decisions get relitigated, and the reasoning behind a
change survives only in a JSONL file nobody will ever open again. The transcripts
are all on disk — `~/.claude*/projects/**/*.jsonl` — but they are write-only in
practice.

This spec covers the first of four sub-projects modelled on
[rowboatlabs/rowboat](https://github.com/rowboatlabs/rowboat), a desktop AI
coworker built around a persistent knowledge graph. The remaining three
(background agents, built-in browser, mini-apps) get their own specs; apps
depend on this one and on background agents, the browser is independent.

### What Rowboat actually does

Read from source, because the README oversells it:

- **Storage** is `~/.rowboat/knowledge/` — a plain Obsidian vault, git-versioned
  via isomorphic-git. Note types are config-driven (`config/notes.json`, seeded
  from `note_system.ts`): People, Organizations, Projects, Topics, Meetings.
  Each type is `{ folder, template, extractionGuide }`. The graph *is* the
  `[[wikilinks]]`; there is no separate graph store.
- **Writing** goes source → markdown → `buildGraph()` → an LLM agent
  (`note_creation.ts`, ~1400 lines of prompt) that reads **one source file per
  run** (`BATCH_SIZE = 1`, deliberately — batching leaks entities between
  unrelated sources) and edits notes itself. Change detection is mtime-then-
  sha256 with state in `knowledge_graph_state.json`.
- **Bloat control** is two mechanisms: an upstream classifier stamps
  `knowledge: extract | skip` into each source's frontmatter and only `extract`
  is admitted; and a daily curation pass (`note_curation.ts`) rewrites the
  most-accumulated notes — collapsing activity older than 60 days into monthly
  summaries, promoting recurring patterns into Key facts, retiring stale Open
  items. Qualifies at ≥8 activity entries, 7-day cooldown, max 8 notes/run.
- **Reading is grep.** `search/search.ts` shells out to grep over
  `knowledge/**/*.md`. There are zero hits for `embedding|qdrant|sqlite-vec|
  cosine` in the desktop core; the Qdrant in `docker-compose.yml` belongs to the
  legacy web product. Agent access is prompt-enforced, not retrieval-engineered:
  *"When the user mentions ANY person, organization, project, or topic by name,
  you MUST look them up in the knowledge base FIRST"* (`copilot/instructions.ts:263`).
- **Auto-injection** is deliberately minimal — only `Agent Notes/user.md` and
  `preferences.md` load verbatim into every workspace-agent prompt
  (`workspace-context.ts:83`), plus a *listing* of other files for on-demand
  read. A `save-to-memory` tool appends to `inbox.md`; a background agent later
  promotes entries into `user.md`/`preferences.md`.

### What transfers and what doesn't

The architecture transfers almost wholesale. Two things don't:

**Retrieval.** Rowboat's corpus is correspondence, where names and nouns appear
literally and grep is adequate. Ours is code-session prose, where one concept
gets phrased many ways — "the decider", "permission-prompt-tool", "the stdio
bridge". Grep is exactly wrong for that, so this design uses SQLite FTS5 with
agent-authored alias and keyword fields.

**Cost.** An email is ~2KB; an OmniFex session JSONL is routinely megabytes of
tool results, file contents, and diffs. Rowboat's one-file-per-LLM-run is
affordable at email size and ruinous at session size. Distillation is therefore
load-bearing here in a way it is not there.

**Ontology.** People/Organizations is a sales-and-meetings ontology. Ours is
Projects/Subsystems/Topics. Notably, a working ontology for this exact corpus
already exists on disk: the Claude Code auto-memory directories
(`$CLAUDE_CONFIG_DIR/projects/<encoded-repo>/memory/`) are typed markdown files
with frontmatter, `[[wikilinks]]`, and a `MEMORY.md` index — the same shape
Rowboat converged on independently. They become a source, not the vault.

## Decisions

| Question | Decision |
|---|---|
| Scope of memory | **One vault per account.** Memory belongs to an account, not the app. Isolation is enforced by process environment — each account's MCP server is spawned with only its own vault path — not by query filters. |
| Retrieval | SQLite FTS5 with agent-authored aliases/keywords. Not grep, not embeddings — there is no embeddings endpoint on a Claude subscription, and introducing one means a new credential and a new cost centre. |
| Sources (v1) | Session transcripts, repo artifacts, explicit capture, auto-memory ingest. GitHub/Jira get the adapter interface but no implementation — they are the only source depending on credentials that are not wired. |
| Auto-memory | Ingested as a source. The vault stays separate; OmniFex never writes into a Claude config dir. |
| Consumption | Brain MCP server + Brain tab + `/recall`. **No** auto-inject on session start — it spends context on every session whether or not it helps. |
| Indexing trigger | Automatic on session terminal state, cheap model, throttled queue, kill switch. |
| Write path | Hybrid: deterministic structure from validated JSON, LLM-authored prose values, agent-writes-files confined to the git-versioned curation pass. |

The write path deserves its rationale. Rowboat lets the agent edit files
directly, which handles merge nuance well but makes the unit of behaviour a
prompt — unverifiable under this repo's TDD and 80%-coverage rules. Fully
deterministic writes are maximally testable but produce a vault that reads like
a database dump, defeating the human-readable property that justifies the
project. The hybrid puts nondeterminism exactly where git can absorb it.

**No new dependencies.** `zod` covers extraction schemas, `better-sqlite3`
provides FTS5, `@uiw/react-md-editor` covers the tab's editor, and git is driven
by spawning the system binary through an injectable exec, matching
`git-branches.ts:1` and `git-worktrees.ts:5`.

## Design

### 1. Vault — one per account

Memory belongs to an account, not to the app. A single shared vault would let a
session running under the personal account retrieve work content through
`brain_search`, breaking the same boundary the user's own global CLAUDE.md
enforces. Every account gets its own vault, its own git repo, and its own
index.

Default `~/Documents/OmniFex Brain/<account-name>/`, overridable per account and
persisted in `app_settings` under `brain.vault.<account_id>`. Deliberately
outside userData: a vault must be openable in Obsidian, backed up, and deletable
without touching OmniFex.

```
OmniFex Brain/<account-name>/
├── .git/                     # system git via execFile, injectable for tests
├── .gitignore                # ignores .omnifex/
├── .omnifex/index.db         # FTS5 index — derived, disposable, not versioned
├── config/notes.json         # note-type definitions
├── Projects/                 # one per repo
├── Subsystems/               # named areas within a project
├── Topics/                   # cross-cutting concerns spanning repos
├── Sessions/                 # append-only digest per indexed session
└── Notes/                    # explicit capture + ingested auto-memory
```

The index DB lives **inside** the vault rather than in `greychrist.db`. That
makes isolation structural rather than conditional: there is no table containing
two accounts' notes, so there is no query that can accidentally cross accounts by
omitting a filter. It also makes a vault self-contained — move the directory and
its index moves with it. The index remains derived and rebuildable from the
Markdown, so excluding it from git costs nothing.

Wikilinks never cross vaults. A `Topics/MCP` note may exist in two accounts'
vaults; they are unrelated notes and are never merged.

Three entity types that accumulate and get curated; two record types that are
append-only. Decisions are **not** a type — they are a `## Decisions` section
inside entity notes, as in Rowboat. Every additional type costs a template, an
extraction target, and a merge path, so the count stays low. `People/` is
dropped: Rowboat needs it because its corpus is correspondence; ours is one
developer in a repo.

Note types are config-driven in `config/notes.json` as
`{ type, folder, template, extractionGuide }`, seeded from defaults. Adding a
type is a config edit, and rendering both the template and the extraction prompt
from one source stops them drifting apart.

### 2. Note format

YAML frontmatter for machine fields, Markdown sections for human content:

```markdown
---
type: Subsystem
project: "[[Projects/omnifex]]"
aliases: [permission decider, permission-prompt-tool, can_use_tool bridge]
keywords: [permissions, stdio, decider, acceptEdits]
created: 2026-05-31
updated: 2026-08-08
curated_at: 2026-08-01
sources: [session:abc123, memory:project_permission_mode_decider]
---
# Permission decider

## Summary
{2-3 sentences, LLM-authored}

## Connected to
- [[Projects/omnifex]] — lives in
- [[Topics/Claude permission rules]] — implements

## Timeline
- **2026-05-31** (session): {description}

## Decisions
- **2026-05-31**: Enforce mid-session permission changes in OmniFex's decider
  rather than the CLI. Only bypass was handled previously.

## Key facts
## Open items
## Assistant notes
```

One deliberate divergence from Rowboat: they encode machine fields as
`**Field:** value` in the body and scrape them with a regex
(`knowledge_index.ts:extractField`), which carries a comment documenting a patch
to stop it bleeding the following line into an empty field. YAML frontmatter
removes that bug class, parses with a real parser, and Obsidian renders it
natively.

`aliases` and `keywords` are load-bearing — they are what makes FTS5 competitive
with semantic search on this corpus. Generating good ones is the extraction
prompt's primary job.

### 3. Git versioning

`git init` on first use. Every write path commits with a typed message
(`Index session <id>`, `Curation`, `Manual edit`), serialized through a promise
mutex so concurrent runs cannot interleave. This is what makes the curation pass
safe: a bad rewrite is one `git revert` away.

Git is a safety net, not a hard dependency. If the binary is unavailable,
indexing proceeds with versioning disabled and a warning surfaced.

### 4. Multi-account

The governing invariant: **the account that owns a source is the account that
indexes it, and the account whose vault receives it.** No source is ever
processed by, or written into, another account.

Account ownership is derived from the source's location, not from `resolve()`:

| Source | Owning account |
|---|---|
| Session transcript | The config dir it lives under — `getAccountByConfigDir()` (`accounts.ts:283`). Definitive; no resolution needed. |
| Auto-memory note | Same: `$CLAUDE_CONFIG_DIR/projects/<encoded>/memory/`. Never a hardcoded `~/.claude/`. |
| Repo artifact | `resolve()` on the repo path (explicit override → longest path rule → `null`). Unresolved means no vault, so the item is skipped and recorded — no silent default-account fallback. |
| Explicit capture | The account whose MCP server received the `brain_remember` call. |

Deriving transcript ownership from the config dir rather than `resolve()` is
deliberate: it stays correct even if path rules change after a session ran.

This also matters beyond storage. Indexing a work transcript through the
personal account would push work content through the wrong subscription — a leak
in the opposite direction from the retrieval one. Binding both the vault and the
indexing account to the source's owner closes both.

There is no separate "Brain account" setting. Cross-project work within a vault
— curation, cross-repo Topic merges — runs under that vault's own account.

Orchestration state stays in `greychrist.db` and carries `account_id`:
`brain_sources (account_id, source_id, item_key, mtime, hash, last_indexed_at,
status, error)` and `brain_queue (account_id, …)`. A single worker drains the
queue across accounts, switching `CLAUDE_CONFIG_DIR` per item. Note *content*
never lives here — only pointers and status.

### 5. Source adapters

```ts
interface BrainSource {
  id: string;                                    // 'session' | 'repo' | 'auto-memory' | 'capture'
  discover(): Promise<SourceItem[]>;             // candidates with a stable key
  admit(item: SourceItem): boolean;              // deterministic gate, no LLM
  distill(item: SourceItem): Promise<string>;    // → bounded prose for the model
}
```

All three methods are independently testable. GitHub/Jira later implement the
same interface with nothing upstream changing.

Every adapter also reports an owning account for each item, per the table in §4.

**Change detection** is Rowboat's hybrid mtime-then-sha256, but state lives in
the `brain_sources` table described in §4 rather than their
`knowledge_graph_state.json`. The DB, migrations, and
`createDatabase(':memory:')` harness already exist, and a JSON blob rewritten
per item is a corruption risk their design simply accepts.

### 6. Distillation

The model must never see raw JSONL. The session adapter keeps **prompts,
assistant prose, and outcomes**, dropping tool results, file contents, diffs,
and attachments entirely. Turns anchor on `userKind === 'prompt'` — the existing
rule from `turnDelta.ts`, not assistant-message adjacency, which miscounts any
turn containing subagents. Ceiling ~8KB per session, truncating oldest-first
with an explicit marker so the model knows it is seeing a tail.

Deterministic metadata — project path, branch, files touched, model, duration,
cost, terminal status — is extracted with **no LLM** and passed as structured
fields. The model supplies prose and aliases only.

### 7. Admission gate

Deterministic, no LLM: skip sessions with fewer than two prompts, sessions that
terminated on a startup error, and sessions with no assistant prose. This drops
the open-a-tab-and-close-it noise that would otherwise dominate the vault. If
precision proves inadequate, an LLM classifier modelled on Rowboat's
`classify_thread.ts` slots in behind the same `admit()` call.

### 8. Extraction

One headless run per admitted item — `BATCH_SIZE = 1`, adopted from Rowboat for
the reason they document. It runs through the existing `AgentEngine`
(`claude-cli-engine.ts`) with the **owning** account's `CLAUDE_CONFIG_DIR` per
§4 — not a resolved or default one — pinned to Haiku, returning JSON validated
by zod:

```ts
const Extraction = z.object({
  entities: z.array(z.object({
    type: z.enum(['Project', 'Subsystem', 'Topic']),
    name: z.string(),
    aliases: z.array(z.string()),
    keywords: z.array(z.string()),
    summary: z.string(),
    links: z.array(z.object({ target: z.string(), relation: z.string() })),
    timelineEntry: z.string().optional(),
    decisions: z.array(z.object({ date: z.string(), text: z.string() })),
    keyFacts: z.array(z.string()),
  })),
});
```

Validation failure retries once, then marks the item `failed` with the error
visible in the Brain tab. A failed item never blocks the queue.

### 9. Merge

`merge(existingNote, extraction, provenance) → newNote` — a pure function, no
I/O, no model. It owns dedup (never append a Timeline entry whose source key is
already in `sources`), section ordering, alias union, and frontmatter stamping.

Idempotency is the property to test hardest: re-indexing the same session twice
must produce a byte-identical note.

### 10. Curation

The one agent-writes-files pass, ported from `note_curation.ts` with the same
qualifying rules — ≥8 timeline entries, modified since `curated_at`, 7-day
cooldown, max 8 notes per run. Collapses old activity into summaries, promotes
recurring patterns into Key facts, retires stale Open items. Commits as
`Curation`. **Off by default** in v1, so nothing silently rewrites notes that
have not been inspected.

### 11. Queue

A `brain_queue` table drained by a worker at concurrency 1. Enqueue happens on
session terminal state via existing lifecycle events (`sessions/events.ts`), so
no new watching machinery. The queue survives restart, and is visible and
pausable in the Brain tab with a global kill switch in Settings.

The worker yields entirely while any interactive session is active. Indexing
must never compete with the user for rate limit.

### 12. FTS5 index

One index per vault, at `<vault>/.omnifex/index.db`. Derived from the Markdown;
the files remain the source of truth and the index is disposable. There is no
`account_id` column because there is no shared table — a search opens exactly
one account's database.

```sql
CREATE VIRTUAL TABLE brain_fts USING fts5(
  note_path UNINDEXED, type UNINDEXED,
  title, aliases, keywords, summary, body,
  tokenize = "porter unicode61 tokenchars '-_'"
);
```

Two details decide whether this works on this corpus:

**`tokenchars '-_'`** — without it, `node-pty` indexes as `node` + `pty` and
`can_use_tool` as three tokens. Code identifiers are most of what gets searched,
so they must survive tokenization intact.

**Query sanitization** — FTS5 `MATCH` takes an expression language, not a
string. Raw input containing `-`, `"`, `*`, `NEAR`, or `OR` either errors or
silently means something other than intended. Queries are tokenized and each
token quoted before assembly. This is the most likely source of "search is
broken" bugs and gets dedicated tests.

Ranking is `bm25()` with title/aliases/keywords weighted well above body, so a
note that *is* about a subsystem outranks one mentioning it in passing.
Retrieval returns note paths; the caller reads the file.

### 13. Brain MCP server

A stdio script registered into **each participating account's** `mcpServers`
block through existing `mcp.ts` machinery, spawned with that account's vault in
its environment:

```jsonc
"omnifex-brain": {
  "command": "<process.execPath>",
  "args": ["<resources>/brain-mcp.js"],
  "env": {
    "ELECTRON_RUN_AS_NODE": "1",
    "OMNIFEX_VAULT": "/Users/…/OmniFex Brain/personal",
    "OMNIFEX_BRAIN_DB": "/Users/…/OmniFex Brain/personal/.omnifex/index.db"
  }
}
```

This is where account isolation is actually enforced. The server has no account
concept and no way to enumerate vaults — it reads the one path it was handed. A
session under the personal account cannot reach the work vault because that
process was never given its location. Isolation is a property of the process
environment, not of application logic that could forget a filter.

Three tools:

- `brain_search(query, type?, project?, limit?)` → ranked hits with snippets
- `brain_read(path)` → full note
- `brain_remember(text, project?)` → the `save-to-memory` equivalent

Three constraints, all load-bearing:

**Spawn as `process.execPath` with `ELECTRON_RUN_AS_NODE=1`**, not system
`node`. `better-sqlite3` is compiled against the Electron ABI in a packaged
build; system node would load a module built for the wrong ABI and crash on
open. Using the Electron binary as a node runtime keeps the ABI matched.

**The MCP process opens the DB read-only.** `brain_remember` does not write to
SQLite; it appends to a capture file in the vault that the queue picks up on its
next drain. This removes cross-process write contention rather than relying on
WAL to paper over it.

**Registration is opt-in per account.** It writes into a real Claude
`settings.json`, so each account is enabled by an explicit, reversible toggle.
Enabling the Brain for one account never touches another's config dir, and an
account with no vault gets no registration.

### 14. Brain tab

A new tab kind, **scoped to exactly one account at a time**, with an explicit
account switcher in the header reusing the existing `AccountBadge` treatment.
Results are never merged across accounts into one list: a search shows one
vault's hits, and switching vaults is a deliberate act. Merged-with-badges was
considered and rejected — it makes cross-account leakage a rendering detail
rather than an impossibility.

Three panes — folder tree, searchable note list, note viewer — plus a backlinks
panel computed from wikilinks.

It is also the operational surface: queue depth, current item, failed items with
their validation errors, Index-now, pause, kill switch. If the indexer starts
writing garbage, this is where it becomes visible, which is why it ships in v1
rather than later.

Editing uses `@uiw/react-md-editor`. Manual edits commit as `Manual edit` and
reindex that note. Graph *visualization* is deferred — Obsidian does it better
and the vault is openable there.

### 15. `/recall`

Registered in OmniFex's own slash-command picker, deliberately **not** written
into `$CLAUDE_CONFIG_DIR/commands/` — the Brain should leave no residue in the
user's Claude config. It searches **only the vault of the session's own
account**, shows ranked results, and inserts selected notes into the prompt.
Zero token cost when unused, and it is the fallback for when the model does not
think to call the MCP tool itself.

### 16. Services and wiring

```
electron/services/brain/
├── index.ts        createBrainService(deps)
├── vault.ts        layout, frontmatter parse/serialize, note read/write
├── git.ts          commit mutex, injectable exec
├── sources/        session-transcripts | repo-artifacts | auto-memory | capture
├── distill.ts      JSONL → bounded prose
├── extract.ts      zod schema + headless agent call
├── merge.ts        pure merge
├── curate.ts       agent-writes-files pass
├── queue.ts        persistent throttled worker
└── search.ts       FTS5
```

`createBrainService` holds a per-account vault registry: `vault.ts`, `git.ts`,
and `search.ts` are all instantiated per vault, so no call site can operate on
"the vault" without having named an account first. Every Brain IPC channel takes
an explicit `accountId`; there is no implicit current-account default, because a
wrong default here is a confidentiality failure rather than a UX annoyance.

New channels go through `src/lib/api.ts` and the `preload.ts` allow-list;
handlers register in `ipc/handlers.ts` against `createBrainService(deps)`
constructed in `main.ts`. Optional `undefined` params stripped before crossing
IPC; adapters accept both camelCase and snake_case.

## Error handling

The governing rule: **the Brain is auxiliary.** Nothing in it may break a
session, block the UI, or consume rate limit needed for real work.

| Failure | Behaviour |
|---|---|
| Vault missing or moved | Brain tab shows a setup state; indexing pauses. No crash, no auto-recreate at a stale path. |
| `git` unavailable | Indexing proceeds, versioning disabled, warning surfaced. |
| Extraction fails zod validation | One retry, then `failed` with the error visible in the tab. Never blocks the queue. |
| No resolved account | Item marked `blocked: no account` and surfaced. No silent default-account fallback, and never written to another account's vault. |
| Account deleted while its vault exists | The vault is **never** deleted — it is user data. It is orphaned, surfaced in the tab as unowned, and read-only until reassigned to an account. |
| Account has no vault configured | Indexing for it is inert and its MCP server is not registered. Not an error. |
| Two accounts pointed at the same vault path | Rejected at configuration time. Shared vaults defeat the entire isolation model. |
| Rate limit hit while indexing | Back off, pause the queue, surface it. |
| FTS index corrupt or stale | Rebuild from the vault. The index is derived and disposable. |
| Hand-edited note has broken frontmatter | Parse failure isolated to that note, shown in the tab. |
| MCP server cannot open the DB | Returns a tool error to Claude, not a crash. |

## Testing

Failing test first; 80% lines on backend. The design was shaped to make this
possible, so the split is deliberate.

Heavily tested, pure, no model and no I/O:

- `merge.ts` — idempotency above all (indexing the same session twice yields
  byte-identical output), plus dedup by source key, alias union, section and
  timeline ordering.
- `distill.ts` — fixture JSONL → bounded prose. Asserts the size ceiling, that
  turns anchor on `userKind === 'prompt'`, and that tool results and file
  contents never appear in output.
- FTS query sanitization — `node-pty`, embedded quotes, bare `OR`, `*`, empty
  string, unicode.
- `admit()` gate rules; frontmatter round-trip; mtime/hash change detection.
- Queue: restart survival, failure isolation, yielding to interactive sessions,
  and correct `CLAUDE_CONFIG_DIR` switching between items owned by different
  accounts.
- Account ownership: transcript path → owning account via
  `getAccountByConfigDir()`; the no-silent-fallback path for unresolved repos;
  rejection of two accounts sharing a vault path.
- **Isolation**: a source owned by account A never produces a write outside A's
  vault, and a search against A's vault never returns a note from B's. Asserted
  with two vaults wired up in a single test, since this is the property whose
  failure is a confidentiality breach rather than a bug.

Fixtures are real session JSONL, redacted and checked in.

**Not unit-testable:** extraction prose quality and curation judgement. Those are
prompts. The mitigations are structural rather than test-based — zod validation
at the boundary, git revert for curation, and the Brain tab for inspection. That
is the reason the tab ships in v1.

**Verification gate:** cross-cutting, so `npm run check`, `npm run build`,
`npm run test:coverage`, then `npm run rebuild:electron` before restarting the
app, since vitest leaves `better-sqlite3` built for Node.

## Build sequence

Ordered so the inspection surface exists before the first automated write.

1. Vault + git + FTS + search, **multi-vault from the start**. No LLM.
   Verifiable end-to-end against hand-written notes in two vaults. Account
   scoping is not retrofittable — a single-vault step 1 would bake shared-table
   assumptions into every layer above it.
2. Brain tab — browse, search, edit, switch accounts. Anything the system
   produces is now visible.
3. Session adapter: `discover` + `admit` + `distill` — still no LLM.
   Distillation output is eyeballed before a token is spent.
4. Extract + merge + queue — first LLM spend, into an inspectable vault.
5. MCP server + `/recall` + the capture adapter — exposed to Claude only once
   contents are trustworthy. The capture adapter ships in the same step as
   `brain_remember`, since that tool's output file is otherwise never consumed.
6. Repo-artifact and auto-memory adapters.
7. Curation, off by default.

Steps 1–3 cost nothing to run and prove the expensive parts are worth building.
If distillation output looks like noise at step 3, no API budget was spent
finding out.

## Out of scope for v1

GitHub/Jira adapters (interface only) · auto-inject on session start · graph
visualization · embeddings and vector search · `People/` notes.

**A shared cross-account tier.** Some knowledge is arguably account-agnostic —
how the user likes work done, rather than what a given project needs. Rowboat
keeps this in `Agent Notes/user.md` at user level. A shared tier is deliberately
excluded from v1: it reintroduces exactly the leakage boundary per-account
vaults exist to remove, and every safeguard would have to be re-argued. If
duplicating preferences across vaults becomes annoying in practice, a read-only
shared tier can be added later — at which point it needs its own explicit
threat model, not a quiet extension of this one.

## Follow-on sub-projects

- **Background agents** — cron and event triggers over the existing `agents` /
  `agent_runs` tables (`database.ts:606`) and `AgentEngine`. Subsumes this
  spec's queue trigger as a special case.
- **Built-in browser** — `WebContentsView` on a partitioned session as a new tab
  kind. No dependency on this spec.
- **Mini-apps** — custom surfaces with Brain and agent access. Depends on both
  this spec and background agents, which is why it is sequenced last.
