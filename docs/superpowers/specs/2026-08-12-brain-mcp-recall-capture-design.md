# Brain Plan 5 — MCP server, `/recall`, and the capture adapter

**Date:** 2026-08-12
**Parent spec:** `docs/superpowers/specs/2026-08-11-brain-memory-vault-design.md`
(§13 Brain MCP server, §15 `/recall`, build-sequence step 5)

Plans 1–4b built a vault, an inspection surface, a session adapter, and an
indexing pipeline with a worker. Everything so far writes *into* the Brain.
This plan is the first that reads *out* of it: the MCP server Claude calls
during a session, the `/recall` fallback for when it does not, and the capture
adapter that consumes what `brain_remember` writes.

## What this corrects in the parent spec

**§13's registration mechanism does not work.** It specifies registering the
server "into each participating account's `mcpServers` block through existing
`mcp.ts` machinery", and `mcp.ts` writes that block into
`<configDir>/settings.json`. Claude Code never reads `mcpServers` from
`settings.json`. User-scope servers live in `<configDir>/.claude.json`;
project-scope servers live in `.mcp.json` at the project root. The only
MCP-related `settings.json` keys are `enableAllProjectMcpServers`,
`enabledMcpjsonServers` and `disabledMcpjsonServers`, and all three govern
*approval* of servers defined elsewhere, not their definition.

Verified on this machine: `~/.claude-work/.claude.json` holds three real
servers (`jira`, `figma-desktop`, `playwright-bridge`, all added by
`claude mcp add`), and neither config dir has an `mcpServers` key in
`settings.json` at all. So the defect is latent rather than destructive —
OmniFex's MCP manager tab has never successfully registered a server, but it
has also never left a stale block behind. **No migration is required; the
service is repointed and the bug closes.**

**§13 assumes a single registration path.** There is a second, better one:
`--mcp-config <file>` (with `--strict-mcp-config` available but deliberately
unused). OmniFex spawns the CLI itself, so it can hand the Brain to a session
at launch and leave nothing in the user's Claude config — the same
no-residue rule §15 already applies to `/recall`. Both paths ship; see §3.

## Decisions

| Question | Decision |
|---|---|
| How the server reaches a session | **Both.** `--mcp-config` at spawn time is the default and needs no user config; a per-account toggle additionally persists into `<configDir>/.claude.json` for sessions started outside OmniFex. |
| MCP protocol implementation | `@modelcontextprotocol/sdk` (1.30.0), bundled into the server's build output. |
| How the server reads the vault | Direct: read-only SQLite for search, `createVault()` for note reads. No IPC back to the main process. |
| What `brain_remember` produces | A capture file consumed by a new source adapter, which runs the same distill → extract → merge pipeline as every other source. |
| Tool permissions | `brain_search` and `brain_read` pre-allowed; `brain_remember` prompts. |
| `/recall` insertion | Full note bodies for the notes you select. |
| Injection scope | Interactive sessions only. Agent runs are unchanged. |
| `mcp.ts` | Fixed in this branch, not deferred. |

## 1. Process model

A new build entry, `electron/brain-mcp.ts`, compiled by a third `VitePlugin`
entry alongside `main` and `preload`, producing `.vite/build/brain-mcp.js`.

The **Claude CLI** spawns it, not OmniFex:

```jsonc
"omnifex-brain": {
  "command": "<process.execPath>",
  "args": ["<app path>/.vite/build/brain-mcp.js"],
  "env": {
    "ELECTRON_RUN_AS_NODE": "1",
    "OMNIFEX_VAULT": "/Users/…/OmniFex Brain/personal",
    "OMNIFEX_BRAIN_DB": "/Users/…/OmniFex Brain/personal/.omnifex/index.db"
  }
}
```

Three properties are load-bearing, all inherited from §13:

**`process.execPath` + `ELECTRON_RUN_AS_NODE=1`, never system `node`.**
`better-sqlite3` is compiled against the Electron ABI in a packaged build.
System node would load a module built for the wrong ABI and abort on open.
This is the same constraint `npm run rebuild:electron` exists to police.

**Read-only on the database.** The server never writes SQLite. This removes
cross-process write contention with the indexing worker rather than relying on
WAL to absorb it.

**No account concept.** The server cannot enumerate vaults and has no accounts
service. It reads the one path it was handed. A session under the personal
account cannot reach the work vault because that process was never told where
it is. Isolation is a property of the process environment, not of a filter
some future call site could forget.

### Dependencies and bundling

`@modelcontextprotocol/sdk` is pure JavaScript, so Vite bundles it into
`brain-mcp.js`. Nothing new has to survive asar packaging or be copied by
`forge.config.ts`'s `afterCopy`. `better-sqlite3` stays external — it is
already externalized in `vite.main.config.ts` and already copied into the
package — which is precisely why the server must run under the Electron
binary.

This is the parent spec's second new dependency, after `js-yaml`. It is
justified on the same grounds: hand-rolling MCP framing and capability
negotiation would put a wire protocol under our maintenance for a server that
exposes three tools, and protocol revisions would arrive as silent
incompatibility rather than a dependency bump.

### Data access

```
brain-mcp.ts
├── openVaultIndexReadOnly(OMNIFEX_BRAIN_DB)   → search
└── createVault(OMNIFEX_VAULT)                 → readNote, listNotes
```

`createVault` is reused rather than reimplemented, and that is the point:
`readNote` already carries realpath containment, the `nlink > 1` hard-link
rejection, and the frontmatter parser. `brain_read` inherits path safety
instead of growing a second, weaker copy of it.

**Refactor this pulls in.** `search.ts` today has one entry point,
`createVaultIndex(dbPath)`, which creates the database it is handed and owns
both the schema and the query. The server needs the query without the
creation. The bm25 weights, the `snippet()` call, the type clause and the row
shape move into one shared internal used by both `createVaultIndex` and a new
`openVaultIndexReadOnly`. `readIndexedCount` already demonstrates the
`{ readonly: true, fileMustExist: true }` open this needs. Copying the SQL into
the server would let ranking drift between the tab and the tool without any
test noticing.

## 2. The three tools

| Tool | Arguments | Result |
|---|---|---|
| `brain_search` | `query`, `type?`, `project?`, `limit?` | Ranked hits: `notePath`, `title`, `type`, `snippet`, `score` |
| `brain_read` | `path` | Frontmatter fields plus the full body |
| `brain_remember` | `text`, `project?` | `{ captured: true, id }` |

Tool descriptions matter more here than usual. Nothing auto-injects the Brain
into a session's context (§ "Out of scope for v1"), so whether the model
reaches for `brain_search` at all depends entirely on how the tool describes
itself. The descriptions state what the vault contains — durable engineering
knowledge extracted from this account's own past sessions — rather than
describing the mechanism.

### `project` needs an index column

The parent spec types `brain_search` with a `project` filter, but `project`
lives only in note frontmatter; `brain_fts` has no such column. It is added as
a second `UNINDEXED` column beside `type`, with a matching `WHERE` clause.

Existing `index.db` files predate the column, so `openVaultIndexReadOnly`
probes for it and reports the index as unavailable when it is missing, and
`createVaultIndex` drops and rebuilds when it opens an old schema. The index is
derived and disposable and `rebuild()` already exists, so this costs one scan
of the vault, once. Deferring the column would mean paying that same cost later
for no benefit now.

### `brain_remember` writes a file, not a note

It appends nothing to SQLite and writes nothing into the vault's Markdown. It
writes exactly one JSON file per call:

```
<vault>/.omnifex/capture/<id>.json
{ "id": "...", "text": "...", "project": "omnifex", "cwd": "/Users/…/omnifex",
  "capturedAt": "2026-08-12T18:04:11.204Z" }
```

One file per capture rather than appends to a shared file: two MCP processes
under the same account are ordinary (two open sessions), and concurrent appends
to one file interleave. `.omnifex/` is already gitignored, so captures do not
enter the vault's git history until the pipeline turns them into a note.

The tool's result says **queued**, not saved. The worker yields entirely while
an interactive session is active (§11), so a fact remembered mid-session
becomes a note after that session ends. Claiming otherwise in the tool result
would teach the model to expect a note that is not there yet.

## 3. Registration

### Spawn-time (default, no user config)

For an interactive session whose resolved account has a configured vault,
OmniFex adds to the spawn:

```
--mcp-config <userData>/brain-mcp/<accountId>.json
--allowedTools mcp__omnifex-brain__brain_search,mcp__omnifex-brain__brain_read
```

Not `--strict-mcp-config`: that would suppress every other MCP server the user
has configured, which is a hostile side effect of enabling a memory tool.

The config file lives in `app.getPath('userData')`, not in the vault. It
contains machine-specific absolute paths including `process.execPath`, and the
vault is a directory the user may sync, open in Obsidian, or copy between
machines. It is rewritten whenever the vault path or the app path changes,
which makes it derived state that can always be regenerated.

`brain_remember` is deliberately absent from `--allowedTools`. Retrieval is
read-only against the user's own vault and prompting on every search would
stop the model using the tool at all; a write — even an append to a capture
file — stays a visible, deliberate act.

Applies to interactive sessions only (`sessions/tui.ts` and the stream-json
spawn path). Agent runs are untouched: they are short, purpose-built, and
adding a memory tool to every one of them changes their token profile for
little gain.

### Persistent (per-account, opt-in)

A toggle in the Brain tab writes the same server block into
`<configDir>/.claude.json` under `mcpServers`, and the two allow rules into
`<configDir>/settings.json` under `permissions.allow`. This is the only path
that leaves residue in a Claude config dir, which is why it is off by default,
per account, and removable from the same toggle.

Rule syntax follows `docs/permission-syntax.md` and the official permissions
docs, both of which must be re-read before that code is written — every
permissions regression in this repo to date came from assuming a rule format.

### Fixing `mcp.ts`

`getSettingsPath(configDir)` returns `<configDir>/settings.json` and every
read and write of `mcpServers` goes through it. User-scope servers are
repointed to `<configDir>/.claude.json`, preserving the `mcpServers` object
shape exactly — the file differs, the block does not. `readProjectConfig` /
`saveProjectConfig` already use `.mcp.json` correctly and are unchanged.

The Brain's persistent registration then reuses `MCPService.add` / `remove`
rather than introducing a second writer of MCP configuration.

No migration ships: neither config dir on this machine has an `mcpServers`
key in `settings.json`, so there is nothing stranded to move. The plan will
re-verify this before the change rather than trusting this paragraph.

## 4. The capture adapter

A fourth `BrainSource`, `electron/services/brain/sources/capture.ts`, id
`capture`:

- **`discover()`** — for each account with a configured vault, list
  `<vault>/.omnifex/capture/*.json`. The owning account is *which vault the
  file is in*. This is the cleanest ownership derivation of any source: no
  path-rule matching, no `getAccountByConfigDir`, no possibility of a guess.
- **`admit()`** — the file parses and `text` is non-empty. There is no
  equivalent of the session gate's 2-prompt rule: a capture is an explicit act,
  and second-guessing it would make the tool untrustworthy.
- **`distill()`** — the captured text *is* the prose. No model, no truncation.

From there the existing pipeline runs unchanged: extractor → `merge()` → note,
under the owning account's `CLAUDE_CONFIG_DIR`. Capture files are never deleted
after indexing. `sourceState` marks them `indexed`, `hasChanged()` reports
false, and `indexSource` skips them for free — so they survive as provenance
and a `force` re-index remains possible.

### The cost this exposes

`DistilledItem.metadata` is typed `SessionMetadata` — `sessionId`,
`promptCount`, `proseCount`, `filesTouched`, `terminalStatus` — and
`buildExtractionPrompt` opens with *"You are extracting durable engineering
knowledge from one coding session"* and states those fields as facts. Both are
wrong for a capture.

`metadata` becomes a discriminated union:

```ts
type ItemMetadata =
  | ({ kind: 'session' } & SessionMetadata)
  | { kind: 'capture'; capturedAt: string; project: string | null; cwd: string | null };
```

and the prompt branches on `kind` for its preamble and its facts block. The
alternative — fabricating a `SessionMetadata` with `sessionId: 'capture:…'` and
`promptCount: 1` — would put a lie in the type and feed the model a false fact
about material it is summarising, which is the exact failure mode Plan 4a
recorded (a model inventing plausible internals it could not see).

Two call sites read `metadata` and both are touched: `extract.ts`'s prompt
builder, and `registry.ts`'s provenance date, which currently reads
`metadata.startedAt` and gains a capture branch reading `capturedAt`.

## 5. `/recall`

Registered in OmniFex's own slash-command picker and deliberately **not**
written into `<configDir>/commands/` — the Brain leaves no residue in the
user's Claude config.

`SlashCommandPicker` builds its list from CLI-sourced and file-sourced
commands. `/recall` is injected as a synthetic entry, badged as OmniFex-local
so it is visibly not a CLI command, and listed **only** when the session's
account has a configured vault. Selecting it opens a search dialog over
`brain_search` for that one account, you select one or more notes, and their
full bodies are inserted at the trigger position under path headers.

Full bodies, not pointers: `/recall` exists as the fallback for a session where
the model did not call the MCP tool — inserting a path or a summary would
re-require the very tool that was not used. The context cost is bounded by what
you deliberately picked.

**The seam this needs.** `useSlashCommandAutocomplete.handleSlashCommandSelect`
only ever inserts text at the cursor. It grows a lookup for OmniFex-local
commands that run a handler instead of inserting, so `/recall` opens a dialog
and every existing command behaves exactly as before. One local command exists
today; the lookup is what keeps the second one from being a special case bolted
onto the first.

Search is scoped to the session's own account, never merged across vaults —
the same rule the Brain tab enforces, for the same reason.

## 6. Error handling

The governing rule is unchanged: **the Brain is auxiliary.** Nothing here may
break a session.

| Failure | Behaviour |
|---|---|
| Index missing, corrupt, or on the pre-`project` schema | `brain_search` returns a tool error naming the Brain tab's rebuild. `brain_read` still works — it reads Markdown, not SQLite. |
| `brain_read` path outside the vault, or a hard-linked note | Rejected by `vault.readNote`'s existing containment and `nlink` checks, surfaced as a tool error. |
| Note with broken frontmatter | That note's parse error is returned. Other notes are unaffected, matching `rebuild()`'s existing isolation. |
| Vault not configured for the account | No `--mcp-config` argument is added, so the tools are simply absent. Not an error. |
| `brain_remember` cannot write | Tool error. Nothing is queued, nothing is silently lost. |
| Capture extraction fails validation | A `failed` queue row with its error visible in the Brain tab, exactly as for a session. The capture file is retained. |
| MCP process cannot start | The CLI reports it in `mcp_server_errors` on `system/init`. The session runs without the Brain. |

## 7. Testing

Failing test first; 80% lines on backend, per repo rules.

- **Isolation, asserted with two vaults in one test.** A server handed vault A
  never returns a hit or a note from vault B, and `brain_remember` never writes
  outside A. This is the property whose failure is a confidentiality breach
  rather than a bug, so it is tested the way Plan 1 tested it — two real vaults
  wired up simultaneously, not one vault and an assumption.
- **Tool handlers** called directly against a fixture vault: search ranking and
  the `type` / `project` filters, `brain_read` on a good note, a broken-
  frontmatter note, and a path escaping the vault; `brain_remember`'s file
  shape and one-file-per-call behaviour under concurrent calls.
- **Read-only index**: opens an existing DB without creating one, refuses a
  missing file, reports an old schema as unavailable, and returns the same
  ranking as the read-write index over the same corpus. That last assertion is
  what makes the extraction a refactor rather than a fork.
- **Capture adapter**: ownership derived from vault location, admit rules,
  distill passthrough, and the unchanged-item skip on a second index.
- **Registration**: the exact JSON written for both paths; spawn args present
  for an account with a vault and absent for one without; the persistent toggle
  writing and then fully removing both the server block and the allow rules.
- **`mcp.ts`**: user-scope reads and writes land in `.claude.json`;
  `.mcp.json` handling is unchanged.
- **`/recall`**: the picker entry appears only with a configured vault, the
  local-command lookup dispatches to a handler instead of inserting, and the
  insertion format is stable.

**Not unit-testable:** whether the model chooses to call `brain_search`, and
whether captured text extracts into a useful note. Those are prompts. The
mitigations are the tool description, the Brain tab, and git.

**Verification gate** (cross-cutting): `npm run check`, `npm run build`,
`npm run test:coverage`, then `npm run rebuild:electron` before restarting the
app, since vitest leaves `better-sqlite3` built for the Node ABI.

## 8. To verify during planning, not assume

- **`--mcp-config` on a `--resume` spawn.** OmniFex re-spawns with `--resume`
  for mid-session toggles (`sessions/tui.ts`). If the flag is ignored on
  resume, the Brain would silently disappear from a session the moment the
  model or permission mode changed.
- **`@modelcontextprotocol/sdk` 1.30.0's actual server API**, via Context7
  before writing against it.
- **Whether `--allowedTools` composes with the account's existing permission
  rules** or replaces them for that session.
- **That `mcpServers` in `settings.json` is genuinely dead** — re-check both
  config dirs immediately before changing `mcp.ts`.

## 9. Out of scope

Repo-artifact and auto-memory adapters (Plan 6) · curation (Plan 7) ·
MCP injection into agent runs · `--strict-mcp-config` · auto-inject of vault
content on session start · any shared cross-account tier.
