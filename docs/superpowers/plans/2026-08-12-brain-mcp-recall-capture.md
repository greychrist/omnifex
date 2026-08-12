# Brain Plan 5 — MCP server, `/recall`, capture adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the Brain vault to Claude — an MCP server with `brain_search` / `brain_read` / `brain_remember`, a `/recall` fallback in OmniFex's own picker, and a capture adapter that turns remembered text into vault notes.

**Architecture:** A standalone stdio MCP server (`electron/brain-mcp.ts`) is spawned by the Claude CLI as `process.execPath` with `ELECTRON_RUN_AS_NODE=1` and two env vars naming one vault. It reads that vault directly: read-only SQLite for FTS, `createVault()` for note reads. OmniFex hands it to sessions with `--mcp-config` at spawn time, and optionally persists it into `<configDir>/.claude.json`. `brain_remember` writes a capture file that a new `BrainSource` feeds through the existing distill → extract → merge pipeline.

**Tech Stack:** TypeScript, Electron, `@modelcontextprotocol/sdk` 1.30.0, `better-sqlite3` (FTS5), `zod` 4, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-12-brain-mcp-recall-capture-design.md`

## Global Constraints

- **Branch:** `feat/brain-mcp-recall`, already created. No git worktrees for this repo (`CLAUDE.md`).
- **TDD is required.** Failing test first, then implementation. Backend target 80% lines.
- **Tests live in** `electron/__tests__/*.test.ts` (backend) and `src/**/__tests__/*.test.tsx` (renderer).
- **Every new invoke channel** must be added to `electron/ipc/channels.ts` (which `electron/preload.ts` allow-lists from) AND surfaced through `src/lib/api.ts`.
- **Strip `undefined`** optional params before crossing IPC; handlers accept camelCase and snake_case.
- **No silent default-account fallback** anywhere. `accountId` is always explicit.
- **The Brain is auxiliary:** nothing here may break a session, block the UI, or crash main.
- **`@modelcontextprotocol/sdk` is pinned at `^1.30.0`**, already installed.
- **Verification gate (cross-cutting):** `npm run check`, `npm run build`, `npm run test:coverage`, then `npm run rebuild:electron` before the app is restarted — vitest leaves `better-sqlite3` built for the Node ABI.

### Verified facts (measured 2026-08-12, CLI 2.1.228 — do not re-litigate)

- `--mcp-config <file>` loads the server on a **fresh** spawn and on a **`--resume`** spawn. Confirmed by reading `mcp_servers` out of the `system/init` event on both.
- `--mcp-config` **merges** with existing MCP config. All 12 of the user's other servers stayed loaded. Therefore **never pass `--strict-mcp-config`**.
- `--allowedTools` **merges** with the account's `settings.json` permission rules; it does not replace them. Confirmed by a run where an `--allowedTools`-granted MCP tool and a settings-granted `Read` both executed without a prompt.
- `claude mcp list` rejects `--mcp-config` (`unknown option`). Do not use it to probe.
- `mcpServers` in `settings.json` is dead. Neither `~/.claude-personal/settings.json` nor `~/.claude-work/settings.json` has the key; `~/.claude-work/.claude.json` holds the three real servers. **No migration is needed.**
- SDK 1.30.0 API: `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'`, `import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'`. `registerTool(name, { description, inputSchema }, cb)` where `inputSchema` is a **raw zod shape** (`{ query: z.string() }`), not `z.object({...})`. Repo zod 4.4.3 satisfies the SDK's `^3.25 || ^4.0`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `electron/services/brain/mcp-tools.ts` | Pure tool logic: `search`, `read`, `remember`. No SDK, no process, no env. This is what tests drive. |
| `electron/brain-mcp.ts` | Process entry. Reads env, builds vault + index, registers tools on `McpServer`, connects stdio. Thin by design; excluded from coverage. |
| `electron/services/brain/mcp-registration.ts` | Builds the server config object, writes the spawn-time config file, and computes spawn args. Pure functions plus one file write. |
| `electron/services/brain/sources/capture.ts` | The capture `BrainSource`. |
| `src/lib/localSlashCommands.ts` | The registry of OmniFex-local slash commands (`/recall` is the only one). |
| `src/components/brain/RecallDialog.tsx` | The `/recall` search-and-insert dialog. |
| `electron/__tests__/brain-mcp-tools.test.ts` | Tool behaviour incl. two-vault isolation. |
| `electron/__tests__/brain-mcp-registration.test.ts` | Config shape, spawn args, file writes. |
| `electron/__tests__/brain-capture-source.test.ts` | Capture adapter. |
| `src/components/__tests__/RecallDialog.test.tsx` | Renderer behaviour for `/recall`. |

**Modified:**

| File | Change |
|---|---|
| `electron/services/brain/search.ts` | Add `project` column; extract shared query; add `openVaultIndexReadOnly`. |
| `electron/services/brain/sources/types.ts` | `ItemMetadata` discriminated union replaces bare `SessionMetadata` on `DistilledItem`. |
| `electron/services/brain/sources/session-transcripts.ts` | Stamp `kind: 'session'`. |
| `electron/services/brain/extract.ts` | Branch the prompt on `metadata.kind`. |
| `electron/services/brain/registry.ts` | Provenance date branches on `kind`; `SourcePreview.metadata` retyped. |
| `electron/services/mcp.ts` | User-scope reads/writes move to `<configDir>/.claude.json`. |
| `electron/services/sessions/tui.ts`, `lifecycle.ts` | Optional `extraArgs` threaded to the spawn. |
| `electron/main.ts` | Wire capture source, spawn-arg provider, registration service. |
| `electron/ipc/brain-handlers.ts`, `electron/ipc/channels.ts` | Three new channels. |
| `src/lib/api.ts` | New API methods and the `BrainItemMetadata` union. |
| `src/components/brain/BrainSources.tsx` | Branch the metadata table on `kind`. |
| `src/components/brain/BrainQueuePanel.tsx` | Per-account "Expose to Claude outside OmniFex" toggle. |
| `src/hooks/useSlashCommandAutocomplete.ts`, `src/components/SlashCommandPicker.tsx`, `src/components/FloatingPromptInput.tsx` | Local-command seam and the `/recall` entry. |
| `forge.config.ts`, `vite.main.config.ts` | Third build entry for `brain-mcp.ts`. |
| `vitest.config.ts` | Exclude `electron/brain-mcp.ts` from coverage. |

---

## Task 1: `project` column and a read-only index opener

**Files:**
- Modify: `electron/services/brain/search.ts`
- Test: `electron/__tests__/brain-search.test.ts`

**Interfaces:**
- Consumes: `createVaultIndex(dbPath)`, `SearchHit`, `SearchOptions` (existing).
- Produces:
  - `SearchOptions` gains `project?: string`.
  - `export interface ReadonlyVaultIndex { search(query: string, opts?: SearchOptions): SearchHit[]; close(): void; }`
  - `export function openVaultIndexReadOnly(dbPath: string): ReadonlyVaultIndex` — throws `BrainIndexUnavailableError` when the file is missing, unreadable, or on the pre-`project` schema.
  - `export class BrainIndexUnavailableError extends Error {}`

- [ ] **Step 1: Write the failing tests**

Append to `electron/__tests__/brain-search.test.ts`:

```ts
describe('project filter', () => {
  it('returns only notes whose frontmatter project matches', () => {
    const index = createVaultIndex(dbPath);
    index.upsert('Subsystems/A.md', 'A', note({ project: '[[Projects/omnifex]]', body: 'permission decider' }));
    index.upsert('Subsystems/B.md', 'B', note({ project: '[[Projects/win]]', body: 'permission decider' }));

    const all = index.search('permission');
    const scoped = index.search('permission', { project: '[[Projects/omnifex]]' });

    expect(all).toHaveLength(2);
    expect(scoped.map((h) => h.notePath)).toEqual(['Subsystems/A.md']);
    index.close();
  });
});

describe('openVaultIndexReadOnly', () => {
  it('reads an existing index without creating one', () => {
    const writer = createVaultIndex(dbPath);
    writer.upsert('Topics/T.md', 'T', note({ body: 'node-pty leak' }));
    writer.close();

    const reader = openVaultIndexReadOnly(dbPath);
    expect(reader.search('node-pty').map((h) => h.notePath)).toEqual(['Topics/T.md']);
    reader.close();
  });

  it('throws BrainIndexUnavailableError for a missing file, creating nothing', () => {
    const missing = join(tmp, 'nope', 'index.db');
    expect(() => openVaultIndexReadOnly(missing)).toThrow(BrainIndexUnavailableError);
    expect(existsSync(missing)).toBe(false);
  });

  it('throws BrainIndexUnavailableError on a pre-project schema', () => {
    const db = new BetterSqlite3(dbPath);
    db.exec(`CREATE VIRTUAL TABLE brain_fts USING fts5(
      note_path UNINDEXED, type UNINDEXED, title, aliases, keywords, summary, body)`);
    db.close();
    expect(() => openVaultIndexReadOnly(dbPath)).toThrow(BrainIndexUnavailableError);
  });

  it('ranks identically to the read-write index over the same corpus', () => {
    const writer = createVaultIndex(dbPath);
    writer.upsert('Subsystems/Queue.md', 'Queue', note({ body: 'the drain worker', keywords: ['queue.ts'] }));
    writer.upsert('Topics/Drain.md', 'Drain', note({ body: 'mentions the queue in passing' }));
    const expected = writer.search('queue');
    writer.close();

    const reader = openVaultIndexReadOnly(dbPath);
    expect(reader.search('queue')).toEqual(expected);
    reader.close();
  });
});

describe('schema migration', () => {
  it('rebuilds when it opens a pre-project index', () => {
    const db = new BetterSqlite3(dbPath);
    db.exec(`CREATE VIRTUAL TABLE brain_fts USING fts5(
      note_path UNINDEXED, type UNINDEXED, title, aliases, keywords, summary, body)`);
    db.prepare(`INSERT INTO brain_fts VALUES (?,?,?,?,?,?,?)`)
      .run('Old.md', 'Note', 'Old', '', '', '', 'stale');
    db.close();

    const index = createVaultIndex(dbPath);
    // The old rows are gone; the caller rebuilds from disk.
    expect(index.search('stale')).toEqual([]);
    index.upsert('New.md', 'New', note({ project: '[[Projects/x]]', body: 'fresh' }));
    expect(index.search('fresh', { project: '[[Projects/x]]' })).toHaveLength(1);
    index.close();
  });
});
```

Use the file's existing `note()` fixture helper if present; otherwise add:

```ts
function note(over: Partial<NoteFrontmatter> & { body?: string } = {}): ParsedNote {
  const { body = '', ...fm } = over;
  return {
    frontmatter: {
      type: 'Note', aliases: [], keywords: [], created: '2026-08-12',
      updated: '2026-08-12', sources: [], ...fm,
    },
    body,
  };
}
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run electron/__tests__/brain-search.test.ts`
Expected: FAIL — `openVaultIndexReadOnly is not a function`, and the project-filter test returns 2 rows.

- [ ] **Step 3: Implement**

In `electron/services/brain/search.ts`:

1. Add `project?: string` to `SearchOptions`.
2. Bump the column list and weights. `project` is `UNINDEXED`, placed beside `type`:

```ts
const COLUMNS = 'note_path UNINDEXED, type UNINDEXED, project UNINDEXED, title, aliases, keywords, summary, body';
/** note_path, type, project, title, aliases, keywords, summary, body */
const BM25_WEIGHTS = '0.0, 0.0, 0.0, 10.0, 8.0, 6.0, 3.0, 1.0';
const BODY_COLUMN = 7;
```

3. Extract the query into a shared function used by both openers:

```ts
function runSearch(db: BetterSqlite3.Database, query: string, opts: SearchOptions): SearchHit[] {
  const match = toFtsQuery(query);
  if (!match) return [];
  const clauses: string[] = [];
  const params: unknown[] = [match];
  if (opts.type) { clauses.push('AND type = ?'); params.push(opts.type); }
  if (opts.project) { clauses.push('AND project = ?'); params.push(opts.project); }
  params.push(opts.limit ?? DEFAULT_LIMIT);
  return db.prepare(
    `SELECT note_path AS notePath, type, title,
            snippet(brain_fts, ${BODY_COLUMN}, '[', ']', '…', 12) AS snippet,
            bm25(brain_fts, ${BM25_WEIGHTS}) AS score
       FROM brain_fts
      WHERE brain_fts MATCH ? ${clauses.join(' ')}
      ORDER BY score ASC LIMIT ?`,
  ).all(...params) as SearchHit[];
}
```

4. Add a schema probe both openers share. `PRAGMA table_info` works on an FTS5 virtual table:

```ts
function hasProjectColumn(db: BetterSqlite3.Database): boolean {
  try {
    const cols = db.prepare('PRAGMA table_info(brain_fts)').all() as { name: string }[];
    return cols.some((c) => c.name === 'project');
  } catch {
    return false;
  }
}
```

5. In `createVaultIndex`, after `CREATE VIRTUAL TABLE IF NOT EXISTS`, drop and recreate when the column is absent. The index is derived and disposable, so this is a rebuild trigger, not data loss:

```ts
if (!hasProjectColumn(db)) {
  db.exec('DROP TABLE IF EXISTS brain_fts');
  db.exec(`CREATE VIRTUAL TABLE brain_fts USING fts5(${COLUMNS}, tokenize = "porter unicode61 tokenchars '-_'")`);
}
```

6. `write()` passes `note.frontmatter.project ?? ''` in the new position.
7. Add the read-only opener:

```ts
export class BrainIndexUnavailableError extends Error {}

export function openVaultIndexReadOnly(dbPath: string): ReadonlyVaultIndex {
  let db: BetterSqlite3.Database;
  try {
    db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    throw new BrainIndexUnavailableError(`no readable Brain index at ${dbPath}`);
  }
  if (!hasProjectColumn(db)) {
    db.close();
    throw new BrainIndexUnavailableError('Brain index predates the project column; rebuild it from the Brain tab');
  }
  return {
    search: (query, opts = {}) => runSearch(db, query, opts),
    close: () => { db.close(); },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run electron/__tests__/brain-search.test.ts electron/__tests__/brain-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/brain/search.ts electron/__tests__/brain-search.test.ts
git commit -m "feat(brain): project column and a read-only index opener"
```

---

## Task 2: MCP tool logic

**Files:**
- Create: `electron/services/brain/mcp-tools.ts`
- Test: `electron/__tests__/brain-mcp-tools.test.ts`

**Interfaces:**
- Consumes: `createVault`, `Vault`, `openVaultIndexReadOnly`, `ReadonlyVaultIndex`, `BrainIndexUnavailableError`, `NoteParseError`.
- Produces:

```ts
export interface BrainMcpDeps {
  vault: Vault;
  /** Null when the index is unavailable; search then reports that, reads still work. */
  openIndex: () => ReadonlyVaultIndex;
  captureDir: string;
  newId: () => string;
  now: () => Date;
}
export interface BrainMcpTools {
  search(args: { query: string; type?: string; project?: string; limit?: number }): { ok: true; hits: SearchHit[] } | { ok: false; error: string };
  read(args: { path: string }): { ok: true; note: ParsedNote } | { ok: false; error: string };
  remember(args: { text: string; project?: string; cwd?: string }): { ok: true; id: string } | { ok: false; error: string };
}
export function createBrainMcpTools(deps: BrainMcpDeps): BrainMcpTools;
export interface CaptureFile { id: string; text: string; project: string | null; cwd: string | null; capturedAt: string; }
```

The index is opened per call and closed after, rather than held open for the process's life: a rebuild from the Brain tab replaces the database file, and a long-lived handle would keep reading the unlinked inode.

- [ ] **Step 1: Write the failing tests**

Create `electron/__tests__/brain-mcp-tools.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVault } from '../services/brain/vault';
import { createVaultIndex, openVaultIndexReadOnly } from '../services/brain/search';
import { createBrainMcpTools } from '../services/brain/mcp-tools';
import type { ParsedNote } from '../services/brain/types';

function makeVault(root: string) {
  mkdirSync(root, { recursive: true });
  const vault = createVault(root);
  vault.ensureLayout();
  return vault;
}

function note(body: string, project?: string): ParsedNote {
  return {
    frontmatter: {
      type: 'Subsystem', aliases: [], keywords: [], created: '2026-08-12',
      updated: '2026-08-12', sources: [], ...(project ? { project } : {}),
    },
    body,
  };
}

function toolsFor(root: string) {
  const vault = createVault(root);
  const dbPath = join(root, '.omnifex', 'index.db');
  let n = 0;
  return createBrainMcpTools({
    vault,
    openIndex: () => openVaultIndexReadOnly(dbPath),
    captureDir: join(root, '.omnifex', 'capture'),
    newId: () => `cap-${String(++n)}`,
    now: () => new Date('2026-08-12T18:00:00.000Z'),
  });
}

describe('brain MCP tools', () => {
  let tmp: string;
  let vaultA: string;
  let vaultB: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brain-mcp-'));
    vaultA = join(tmp, 'A');
    vaultB = join(tmp, 'B');
    const a = makeVault(vaultA);
    const b = makeVault(vaultB);
    a.writeNote('Subsystems/Queue.md', note('the drain worker yields to sessions', '[[Projects/omnifex]]'));
    b.writeNote('Subsystems/Secret.md', note('work-account material nobody else may read'));
    for (const [root, vault] of [[vaultA, a], [vaultB, b]] as const) {
      const index = createVaultIndex(join(root, '.omnifex', 'index.db'));
      index.rebuild(vault);
      index.close();
    }
  });

  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('searches its own vault', () => {
    const res = toolsFor(vaultA).search({ query: 'drain' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.hits.map((h) => h.notePath)).toEqual(['Subsystems/Queue.md']);
  });

  it('never returns another vault to the account it was not handed', () => {
    const a = toolsFor(vaultA);
    expect(a.search({ query: 'work-account' })).toEqual({ ok: true, hits: [] });
    const read = a.read({ path: '../B/Subsystems/Secret.md' });
    expect(read.ok).toBe(false);
  });

  it('filters by project', () => {
    const t = toolsFor(vaultA);
    expect(t.search({ query: 'drain', project: '[[Projects/omnifex]]' })).toMatchObject({ ok: true });
    const other = t.search({ query: 'drain', project: '[[Projects/win]]' });
    expect(other.ok && other.hits).toEqual([]);
  });

  it('reports an unavailable index as an error rather than throwing', () => {
    rmSync(join(vaultA, '.omnifex', 'index.db'));
    const res = toolsFor(vaultA).search({ query: 'drain' });
    expect(res).toEqual({ ok: false, error: expect.stringContaining('Brain index') });
  });

  it('reads a note whole', () => {
    const res = toolsFor(vaultA).read({ path: 'Subsystems/Queue.md' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.note.body).toContain('drain worker');
  });

  it('reads notes even when the index is gone', () => {
    rmSync(join(vaultA, '.omnifex', 'index.db'));
    expect(toolsFor(vaultA).read({ path: 'Subsystems/Queue.md' }).ok).toBe(true);
  });

  it('surfaces a broken note as an error, not a crash', () => {
    writeFileSync(join(vaultA, 'Subsystems', 'Broken.md'), '---\ntype: [unclosed\n---\nbody\n');
    const res = toolsFor(vaultA).read({ path: 'Subsystems/Broken.md' });
    expect(res.ok).toBe(false);
  });

  it('writes one capture file per call', () => {
    const t = toolsFor(vaultA);
    const first = t.remember({ text: 'node-pty must stay on the beta', project: 'omnifex', cwd: '/repo' });
    const second = t.remember({ text: 'second thought' });
    expect(first).toEqual({ ok: true, id: 'cap-1' });
    expect(second).toEqual({ ok: true, id: 'cap-2' });

    const dir = join(vaultA, '.omnifex', 'capture');
    expect(readdirSync(dir).sort()).toEqual(['cap-1.json', 'cap-2.json']);
    expect(JSON.parse(readFileSync(join(dir, 'cap-1.json'), 'utf8'))).toEqual({
      id: 'cap-1',
      text: 'node-pty must stay on the beta',
      project: 'omnifex',
      cwd: '/repo',
      capturedAt: '2026-08-12T18:00:00.000Z',
    });
  });

  it('rejects empty capture text', () => {
    expect(toolsFor(vaultA).remember({ text: '   ' }).ok).toBe(false);
  });

  it('never writes a capture outside its own vault', () => {
    toolsFor(vaultA).remember({ text: 'x' });
    expect(readdirSync(join(vaultB, '.omnifex')).includes('capture')).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run electron/__tests__/brain-mcp-tools.test.ts`
Expected: FAIL — cannot resolve `../services/brain/mcp-tools`.

- [ ] **Step 3: Implement `electron/services/brain/mcp-tools.ts`**

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Vault } from './vault';
import type { ParsedNote } from './types';
import type { ReadonlyVaultIndex, SearchHit } from './search';
import { NoteParseError } from './frontmatter';

export interface CaptureFile {
  id: string;
  text: string;
  project: string | null;
  cwd: string | null;
  capturedAt: string;
}

export interface BrainMcpDeps {
  vault: Vault;
  openIndex: () => ReadonlyVaultIndex;
  captureDir: string;
  newId: () => string;
  now: () => Date;
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface BrainMcpTools {
  search(args: { query: string; type?: string; project?: string; limit?: number }): Result<{ hits: SearchHit[] }>;
  read(args: { path: string }): Result<{ note: ParsedNote }>;
  remember(args: { text: string; project?: string; cwd?: string }): Result<{ id: string }>;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createBrainMcpTools(deps: BrainMcpDeps): BrainMcpTools {
  return {
    search(args) {
      let index: ReadonlyVaultIndex;
      try {
        index = deps.openIndex();
      } catch (err) {
        // A missing or stale index is a reportable condition, not a crash: the
        // Brain is auxiliary and `read` still works without it.
        return { ok: false, error: message(err) };
      }
      try {
        return { ok: true, hits: index.search(args.query, {
          type: args.type, project: args.project, limit: args.limit,
        }) };
      } catch (err) {
        return { ok: false, error: message(err) };
      } finally {
        index.close();
      }
    },

    read(args) {
      try {
        // Containment, hard-link rejection and frontmatter parsing all live in
        // vault.readNote. Re-implementing any of them here would be a second,
        // weaker copy of the checks that keep one vault out of another.
        return { ok: true, note: deps.vault.readNote(args.path) };
      } catch (err) {
        if (err instanceof NoteParseError) {
          return { ok: false, error: `cannot read note: ${err.message}` };
        }
        return { ok: false, error: message(err) };
      }
    },

    remember(args) {
      const text = args.text.trim();
      if (!text) return { ok: false, error: 'text is required' };
      const id = deps.newId();
      const payload: CaptureFile = {
        id,
        text,
        project: args.project ?? null,
        cwd: args.cwd ?? null,
        capturedAt: deps.now().toISOString(),
      };
      try {
        mkdirSync(deps.captureDir, { recursive: true });
        // One file per capture. Two sessions under one account run two of these
        // processes, and concurrent appends to a shared file interleave.
        writeFileSync(join(deps.captureDir, `${id}.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      } catch (err) {
        return { ok: false, error: message(err) };
      }
      return { ok: true, id };
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run electron/__tests__/brain-mcp-tools.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/services/brain/mcp-tools.ts electron/__tests__/brain-mcp-tools.test.ts
git commit -m "feat(brain): MCP tool logic with two-vault isolation tests"
```

---

## Task 3: The MCP server process and its build entry

**Files:**
- Create: `electron/brain-mcp.ts`
- Modify: `forge.config.ts`, `vitest.config.ts`
- Test: manual smoke test (documented below) — the entry is thin glue over Task 2, which is fully unit-tested.

**Interfaces:**
- Consumes: `createBrainMcpTools`, `createVault`, `openVaultIndexReadOnly`.
- Produces: `.vite/build/brain-mcp.js`, an executable stdio MCP server reading `OMNIFEX_VAULT` and `OMNIFEX_BRAIN_DB`.

- [ ] **Step 1: Write the entry**

Create `electron/brain-mcp.ts`:

```ts
/**
 * The Brain MCP server. Spawned by the Claude CLI — never by OmniFex — as
 * `process.execPath` with ELECTRON_RUN_AS_NODE=1, so better-sqlite3 loads
 * against the Electron ABI it was built for.
 *
 * It has no account concept and cannot enumerate vaults. It reads the one path
 * it was handed. That is the whole isolation model: a session under the
 * personal account cannot reach the work vault because this process was never
 * told where it is.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createVault } from './services/brain/vault';
import { openVaultIndexReadOnly } from './services/brain/search';
import { createBrainMcpTools } from './services/brain/mcp-tools';

const vaultRoot = process.env.OMNIFEX_VAULT;
if (!vaultRoot) {
  process.stderr.write('brain-mcp: OMNIFEX_VAULT is required\n');
  process.exit(1);
}
const dbPath = process.env.OMNIFEX_BRAIN_DB ?? join(vaultRoot, '.omnifex', 'index.db');

const tools = createBrainMcpTools({
  vault: createVault(vaultRoot),
  openIndex: () => openVaultIndexReadOnly(dbPath),
  captureDir: join(vaultRoot, '.omnifex', 'capture'),
  newId: () => randomUUID(),
  now: () => new Date(),
});

const server = new McpServer({ name: 'omnifex-brain', version: '1.0.0' });

/** MCP wants text content; a failed tool is `isError`, never a thrown exception. */
function reply(result: { ok: boolean; error?: string } & Record<string, unknown>, body: () => unknown) {
  if (!result.ok) {
    return { isError: true, content: [{ type: 'text' as const, text: result.error ?? 'unknown error' }] };
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(body(), null, 2) }] };
}

server.registerTool(
  'brain_search',
  {
    description:
      'Search this account\'s OmniFex Brain — durable engineering knowledge distilled from its own past Claude Code sessions: subsystems, decisions, and facts with the identifiers a developer would actually type. Use it before asking the user to re-explain prior work, and before assuming how something in this codebase came to be.',
    inputSchema: {
      query: z.string().describe('Search terms. Identifiers and file names work well.'),
      type: z.enum(['Project', 'Subsystem', 'Topic', 'Session', 'Note']).optional(),
      project: z.string().optional().describe('Wikilink to a project note, e.g. "[[Projects/omnifex]]".'),
      limit: z.number().int().positive().max(50).optional(),
    },
  },
  ({ query, type, project, limit }) => {
    const res = tools.search({ query, type, project, limit });
    return reply(res, () => (res.ok ? res.hits : []));
  },
);

server.registerTool(
  'brain_read',
  {
    description: 'Read one Brain note whole, by the vault-relative path a brain_search hit reports.',
    inputSchema: { path: z.string().describe('Vault-relative path, e.g. "Subsystems/Queue.md".') },
  },
  ({ path }) => {
    const res = tools.read({ path });
    return reply(res, () => (res.ok ? res.note : null));
  },
);

server.registerTool(
  'brain_remember',
  {
    description:
      'Record a durable fact into this account\'s Brain. Use for things that will still matter in six months — a decision and its reason, a constraint, a gotcha. The text is queued and becomes a note after the current session ends; it is not written immediately.',
    inputSchema: {
      text: z.string().describe('The fact, in prose. Include why, not just what.'),
      project: z.string().optional().describe('Project this belongs to, e.g. "omnifex".'),
    },
  },
  ({ text, project }) => {
    const res = tools.remember({ text, project, cwd: process.cwd() });
    return reply(res, () => ({ captured: true, id: res.ok ? res.id : null, status: 'queued for indexing' }));
  },
);

await server.connect(new StdioServerTransport());
```

- [ ] **Step 2: Add the build entry**

In `forge.config.ts`, add a third entry to the `VitePlugin` `build` array:

```ts
{ entry: 'electron/brain-mcp.ts', config: 'vite.main.config.ts', target: 'main' },
```

In `vitest.config.ts`, add to `coverage.exclude` beside `electron/main.ts`:

```ts
// Thin process entry over mcp-tools.ts, which is fully tested. Running it
// means spawning a stdio process; the logic it glues has no coverage gap.
'electron/brain-mcp.ts',
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run check`
Expected: PASS.

Run: `npx vite build --config vite.main.config.ts` is not how forge drives it — instead run `npm run package` only if a full check is wanted. For this step, `npm run check` passing plus Step 4's smoke test is the gate.

- [ ] **Step 4: Smoke-test the real server against a real vault**

Build the entry once so a runnable file exists:

```bash
npx vite build --config vite.main.config.ts --outDir .vite/build --emptyOutDir=false \
  --ssr electron/brain-mcp.ts
```

Then drive it through the CLI, which is the only test that proves ABI, bundling and protocol together:

```bash
VAULT="$(node -e "
const db=require('better-sqlite3')(process.env.HOME+'/Library/Application Support/OmniFex/greychrist.db');
const r=db.prepare('SELECT value FROM app_settings WHERE key LIKE ?').all('brain.vaultPath%');
console.log(JSON.stringify(r));
")"
echo "$VAULT"   # locate a configured vault path
```

Write `/tmp/brain-mcp-smoke.json` using the discovered vault path:

```jsonc
{"mcpServers":{"omnifex-brain":{
  "command":"<absolute path to node or Electron>",
  "args":["<repo>/.vite/build/brain-mcp.js"],
  "env":{"ELECTRON_RUN_AS_NODE":"1","OMNIFEX_VAULT":"<vault>","OMNIFEX_BRAIN_DB":"<vault>/.omnifex/index.db"}}}}
```

```bash
CLAUDE_CONFIG_DIR="$HOME/.claude-personal" command claude -p \
  "Call brain_search for 'queue' and reply with just the number of hits." \
  --output-format json --mcp-config /tmp/brain-mcp-smoke.json \
  --allowedTools "mcp__omnifex-brain__brain_search"
```

Expected: `is_error: false` and a hit count. If the server fails to connect, re-run with `--output-format stream-json --verbose` and read `mcp_servers` in the `system/init` event.

Record the observed result in the plan's Notes section at the bottom.

- [ ] **Step 5: Commit**

```bash
git add electron/brain-mcp.ts forge.config.ts vitest.config.ts package.json package-lock.json
git commit -m "feat(brain): stdio MCP server exposing search, read and remember"
```

---

## Task 4: Capture source adapter and the metadata union

**Files:**
- Create: `electron/services/brain/sources/capture.ts`
- Modify: `electron/services/brain/sources/types.ts`, `sources/session-transcripts.ts`, `extract.ts`, `registry.ts`, `main.ts`, `src/lib/api.ts`, `src/components/brain/BrainSources.tsx`
- Test: `electron/__tests__/brain-capture-source.test.ts`, plus updates to `brain-distill.test.ts` / `brain-extract.test.ts` fixtures

**Interfaces:**
- Consumes: `BrainSource`, `SourceItem`, `AdmitVerdict`, `DistilledItem`, `CaptureFile` (Task 2).
- Produces:

```ts
export type ItemMetadata =
  | ({ kind: 'session' } & SessionMetadata)
  | { kind: 'capture'; capturedAt: string; project: string | null; cwd: string | null };

export interface CaptureSourceDeps {
  /** Configured vaults, by account. Ownership is derived from which vault a file sits in. */
  vaults: () => { accountId: number; root: string }[];
}
export function createCaptureSource(deps: CaptureSourceDeps): BrainSource; // id: 'capture'
```

- [ ] **Step 1: Write the failing tests**

Create `electron/__tests__/brain-capture-source.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCaptureSource } from '../services/brain/sources/capture';

function writeCapture(root: string, id: string, over: Record<string, unknown> = {}) {
  const dir = join(root, '.omnifex', 'capture');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({
    id, text: `fact ${id}`, project: 'omnifex', cwd: '/repo',
    capturedAt: '2026-08-12T18:00:00.000Z', ...over,
  }));
}

describe('capture source', () => {
  let tmp: string, a: string, b: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brain-capture-'));
    a = join(tmp, 'A'); b = join(tmp, 'B');
  });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  const source = () => createCaptureSource({ vaults: () => [
    { accountId: 1, root: a }, { accountId: 2, root: b },
  ] });

  it('derives the owning account from which vault the file is in', async () => {
    writeCapture(a, 'cap-1');
    writeCapture(b, 'cap-2');
    const items = await source().discover();
    expect(items.map((i) => [i.accountId, i.itemKey]).sort()).toEqual([[1, 'cap-1'], [2, 'cap-2']]);
    expect(items.every((i) => i.sourceId === 'capture')).toBe(true);
  });

  it('returns nothing when no vault has captures', async () => {
    expect(await source().discover()).toEqual([]);
  });

  it('admits a capture with text', async () => {
    writeCapture(a, 'cap-1');
    const [item] = await source().discover();
    expect(source().admit(item)).toEqual({ admitted: true, reason: expect.any(String) });
  });

  it('skips an empty capture with a reason', async () => {
    writeCapture(a, 'cap-1', { text: '   ' });
    const [item] = await source().discover();
    expect(source().admit(item)).toEqual({ admitted: false, reason: expect.stringContaining('empty') });
  });

  it('skips an unparseable capture rather than throwing', async () => {
    mkdirSync(join(a, '.omnifex', 'capture'), { recursive: true });
    writeFileSync(join(a, '.omnifex', 'capture', 'bad.json'), '{not json');
    const [item] = await source().discover();
    expect(source().admit(item).admitted).toBe(false);
  });

  it('distills the captured text verbatim with capture metadata', async () => {
    writeCapture(a, 'cap-1', { text: 'node-pty must stay on 1.2.0-beta.13' });
    const [item] = await source().discover();
    const distilled = await source().distill(item);
    expect(distilled.truncated).toBe(false);
    expect(distilled.prose).toBe('node-pty must stay on 1.2.0-beta.13');
    expect(distilled.metadata).toEqual({
      kind: 'capture', capturedAt: '2026-08-12T18:00:00.000Z', project: 'omnifex', cwd: '/repo',
    });
  });
});
```

Add to `electron/__tests__/brain-extract.test.ts`:

```ts
it('prompts differently for a capture than for a session', () => {
  const capture = buildExtractionPrompt({
    prose: 'node-pty must stay on the beta',
    truncated: false,
    metadata: { kind: 'capture', capturedAt: '2026-08-12T18:00:00.000Z', project: 'omnifex', cwd: '/repo' },
  });
  expect(capture).toContain('explicitly captured');
  expect(capture).not.toContain('coding session');
  expect(capture).not.toContain('prompts,');
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run electron/__tests__/brain-capture-source.test.ts electron/__tests__/brain-extract.test.ts`
Expected: FAIL — module not found, and `buildExtractionPrompt` reads `metadata.sessionId`.

- [ ] **Step 3: Widen the metadata type**

In `sources/types.ts`, replace `DistilledItem.metadata`'s type:

```ts
/**
 * What a distillation knows about its item. A discriminated union rather than
 * one shape with optional fields: the extraction prompt STATES these as facts,
 * and a capture that reported `promptCount: 1` would be feeding the model a
 * fabricated fact about the material it is summarising.
 */
export type ItemMetadata =
  | ({ kind: 'session' } & SessionMetadata)
  | { kind: 'capture'; capturedAt: string; project: string | null; cwd: string | null };

export interface DistilledItem {
  prose: string;
  metadata: ItemMetadata;
  truncated: boolean;
}
```

In `sources/session-transcripts.ts`, stamp the discriminant where `distill` builds its return value: `metadata: { kind: 'session', ...metadata }`.

- [ ] **Step 4: Branch the extraction prompt**

In `extract.ts`'s `buildExtractionPrompt`, replace the `const m = item.metadata; const facts = [...]` block with:

```ts
const m = item.metadata;
const preamble =
  m.kind === 'capture'
    ? 'You are turning one fact a developer explicitly captured into durable vault entities.'
    : 'You are extracting durable engineering knowledge from one coding session.';
const facts =
  m.kind === 'capture'
    ? [
        `captured: ${m.capturedAt}`,
        `project: ${m.project ?? 'unknown'}`,
        `working directory: ${m.cwd ?? 'unknown'}`,
      ].join('\n')
    : [
        `session: ${m.sessionId}`,
        `project: ${m.projectPath ?? 'unknown'}`,
        `branch: ${m.gitBranch ?? 'unknown'}`,
        `started: ${m.startedAt ?? 'unknown'}`,
        `turns: ${String(m.promptCount)} prompts, ${String(m.proseCount)} replies`,
        `files touched: ${m.filesTouched.length > 0 ? m.filesTouched.join(', ') : 'none'}`,
        `outcome: ${m.terminalStatus}`,
      ].join('\n');
```

and use `${preamble}` where the hard-coded session sentence is today. The truncation note only applies to sessions; guard it with `item.truncated` as it already is (a capture is never truncated).

- [ ] **Step 5: Implement the capture source**

Create `electron/services/brain/sources/capture.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AdmitVerdict, BrainSource, DistilledItem, SourceItem } from './types';
import type { CaptureFile } from '../mcp-tools';

export interface CaptureSourceDeps {
  vaults: () => { accountId: number; root: string }[];
}

const CAPTURE_DIR = join('.omnifex', 'capture');

function readCapture(path: string): CaptureFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CaptureFile>;
    if (typeof parsed.text !== 'string') return null;
    return {
      id: typeof parsed.id === 'string' ? parsed.id : '',
      text: parsed.text,
      project: typeof parsed.project === 'string' ? parsed.project : null,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null,
      capturedAt: typeof parsed.capturedAt === 'string' ? parsed.capturedAt : '',
    };
  } catch {
    return null;
  }
}

/**
 * Captures written by the MCP server's `brain_remember`.
 *
 * Ownership needs no resolution at all here: a capture file sits INSIDE one
 * account's vault, so the account is a property of the path. This is the
 * strongest form of the rule the session adapter approximates with
 * `getAccountByConfigDir`.
 */
export function createCaptureSource(deps: CaptureSourceDeps): BrainSource {
  return {
    id: 'capture',

    discover(): Promise<SourceItem[]> {
      const items: SourceItem[] = [];
      for (const { accountId, root } of deps.vaults()) {
        const dir = join(root, CAPTURE_DIR);
        let names: string[];
        try {
          names = readdirSync(dir).filter((n) => n.endsWith('.json'));
        } catch {
          continue; // No captures for this vault yet. Not an error.
        }
        for (const name of names) {
          const path = join(dir, name);
          try {
            const stat = statSync(path);
            items.push({
              sourceId: 'capture',
              itemKey: name.replace(/\.json$/, ''),
              accountId,
              path,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              label: readCapture(path)?.project ?? 'capture',
            });
          } catch {
            // A file that vanished between readdir and stat is not an error.
          }
        }
      }
      return Promise.resolve(items);
    },

    admit(item: SourceItem): AdmitVerdict {
      const capture = readCapture(item.path);
      if (!capture) return { admitted: false, reason: 'capture file is unreadable or malformed' };
      if (!capture.text.trim()) return { admitted: false, reason: 'capture text is empty' };
      // No prompt-count equivalent: a capture is an explicit act, and
      // second-guessing it would make the tool untrustworthy.
      return { admitted: true, reason: 'explicit capture' };
    },

    distill(item: SourceItem): Promise<DistilledItem> {
      const capture = readCapture(item.path);
      if (!capture) throw new Error(`capture file is unreadable: ${item.path}`);
      return Promise.resolve({
        prose: capture.text.trim(),
        truncated: false,
        metadata: {
          kind: 'capture',
          capturedAt: capture.capturedAt,
          project: capture.project,
          cwd: capture.cwd,
        },
      });
    },
  };
}
```

- [ ] **Step 6: Fix the provenance date in `registry.ts`**

At the `provenance` construction (`registry.ts` ~line 937), replace the date expression:

```ts
const provenance = {
  sourceKey: `${item.sourceId}:${item.itemKey}`,
  date:
    distilled.metadata.kind === 'capture'
      ? (distilled.metadata.capturedAt.slice(0, 10) || today())
      : (distilled.metadata.startedAt?.slice(0, 10) ?? today()),
};
```

Retype `SourcePreview.metadata` (registry.ts ~line 155) from `SessionMetadata` to `ItemMetadata` and update the import.

- [ ] **Step 7: Update the renderer types and the Sources pane**

In `src/lib/api.ts`, add beside `BrainSessionMetadata`:

```ts
/** Mirrors `ItemMetadata` in electron/services/brain/sources/types.ts. */
export type BrainItemMetadata =
  | ({ kind: 'session' } & BrainSessionMetadata)
  | { kind: 'capture'; capturedAt: string; project: string | null; cwd: string | null };
```

and change `BrainSourcePreview.metadata` to `BrainItemMetadata`.

In `src/components/brain/BrainSources.tsx`, wrap the existing `<dl>` rows in a `preview.metadata.kind === 'session'` branch and add the capture arm:

```tsx
{preview.metadata.kind === 'capture' ? (
  <>
    <dt>Captured</dt><dd>{preview.metadata.capturedAt.slice(0, 10)}</dd>
    <dt>Project</dt><dd className="truncate">{preview.metadata.project ?? '—'}</dd>
    <dt>Directory</dt><dd className="truncate">{preview.metadata.cwd ?? '—'}</dd>
  </>
) : (
  /* existing session rows, unchanged */
)}
```

- [ ] **Step 8: Wire the source into `main.ts`**

Where `createBrainService` is constructed (`main.ts:482`), add the capture source to the `sources` array. It needs the configured vaults, which the service itself knows — so build it from the accounts list and `brainService.vaultPath`. Because the source is constructed before the service, pass a late-bound getter:

```ts
let brainRef: BrainService | undefined;
const captureSource = createCaptureSource({
  vaults: () =>
    accountsService
      .listAccounts()
      .map((a) => ({ accountId: a.id, root: brainRef?.vaultPath(a.id) ?? '' }))
      .filter((v) => v.root !== ''),
});
const brainService: BrainService | undefined = createBrainService(db, {
  /* existing options */,
  sources: [sessionSource, captureSource],
});
brainRef = brainService;
```

- [ ] **Step 9: Run the tests**

Run: `npx vitest run electron/__tests__/brain-capture-source.test.ts electron/__tests__/brain-extract.test.ts electron/__tests__/brain-distill.test.ts electron/__tests__/brain-registry.test.ts electron/__tests__/brain-ipc.test.ts`
Expected: PASS. Fix any fixture that constructs a `DistilledItem` without `kind`.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(brain): capture source adapter and a metadata discriminant"
```

---

## Task 5: Repoint `mcp.ts` at `.claude.json`

**Files:**
- Modify: `electron/services/mcp.ts`
- Test: `electron/__tests__/mcp.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing new.
- Produces: unchanged `MCPService` surface. Only the backing file for user-scope `mcpServers` changes.

- [ ] **Step 1: Confirm the premise before changing anything**

Run:

```bash
node -e "for (const d of [process.env.HOME+'/.claude-personal', process.env.HOME+'/.claude-work']) for (const f of ['settings.json','.claude.json']) { try { const j=JSON.parse(require('fs').readFileSync(d+'/'+f,'utf8')); console.log(d+'/'+f, j.mcpServers?Object.keys(j.mcpServers):'(none)'); } catch { console.log(d+'/'+f,'unreadable'); } }"
```

Expected: `settings.json` shows `(none)` for both dirs. If either shows servers, stop and add a migration step — the assumption "nothing is stranded" would be false.

- [ ] **Step 2: Write the failing test**

Create/append `electron/__tests__/mcp.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMCPService } from '../services/mcp';

describe('MCP user-scope storage', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mcp-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes servers into .claude.json, not settings.json', () => {
    const svc = createMCPService();
    svc.add({ name: 'omnifex-brain', command: '/bin/node', args: ['x.js'], configDir: dir });

    const claudeJson = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'));
    expect(Object.keys(claudeJson.mcpServers)).toEqual(['omnifex-brain']);
    expect(claudeJson.mcpServers['omnifex-brain']).toEqual({ command: '/bin/node', args: ['x.js'] });
    expect(existsSync(join(dir, 'settings.json'))).toBe(false);
  });

  it('reads servers a real CLI wrote', () => {
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({
      mcpServers: { jira: { command: 'jira-mcp' } },
      projects: { '/some/path': { allowedTools: [] } },
    }));
    expect(createMCPService().list(dir).map((s) => s.name)).toEqual(['jira']);
  });

  it('preserves unrelated keys when writing', () => {
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { uuid: 'x' } }));
    createMCPService().add({ name: 'a', command: 'c', configDir: dir });
    const after = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'));
    expect(after.oauthAccount).toEqual({ uuid: 'x' });
  });

  it('removes a server without dropping the file', () => {
    const svc = createMCPService();
    svc.add({ name: 'a', command: 'c', configDir: dir });
    svc.add({ name: 'b', command: 'c', configDir: dir });
    svc.remove('a', dir);
    expect(svc.list(dir).map((s) => s.name)).toEqual(['b']);
  });

  it('still requires an explicit configDir', () => {
    expect(() => createMCPService().list()).toThrow(/configDir is required/);
  });
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `npx vitest run electron/__tests__/mcp.test.ts`
Expected: FAIL — `.claude.json` does not exist; the service wrote `settings.json`.

- [ ] **Step 4: Implement**

In `electron/services/mcp.ts`, rename `getSettingsPath` to `getUserConfigPath` and change the joined filename, keeping the no-fallback throw verbatim:

```ts
/**
 * User-scope MCP servers live in `<configDir>/.claude.json`, NOT settings.json.
 * Claude Code has never read an `mcpServers` key from settings.json; writing
 * there produced a config the CLI silently ignored (fixed 2026-08-12).
 */
function getUserConfigPath(configDir?: string): string {
  if (!configDir) {
    throw new Error(
      'MCP: configDir is required. The renderer must pass the resolved ' +
      "account's config_dir; there is no default-account fallback.",
    );
  }
  return path.join(configDir, '.claude.json');
}
```

Update `readSettings`/`writeSettings` call sites to use it. `readProjectConfig` / `saveProjectConfig` (`.mcp.json`) are unchanged. Rename the local helpers `readSettings`/`writeSettings` to `readJsonFile`/`writeJsonFile` so no name still claims these touch settings.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run electron/__tests__/mcp.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/services/mcp.ts electron/__tests__/mcp.test.ts
git commit -m "fix(mcp): user-scope servers live in .claude.json, not settings.json"
```

---

## Task 6: Registration — spawn args and the persistent toggle

**Files:**
- Create: `electron/services/brain/mcp-registration.ts`
- Modify: `electron/services/sessions/tui.ts`, `electron/services/sessions/lifecycle.ts`, `electron/main.ts`, `electron/ipc/brain-handlers.ts`, `electron/ipc/channels.ts`, `src/lib/api.ts`
- Test: `electron/__tests__/brain-mcp-registration.test.ts`

**Interfaces:**
- Consumes: `MCPService` (Task 5), `BrainService.vaultPath`, `AccountsService`.
- Produces:

```ts
export const BRAIN_MCP_SERVER_NAME = 'omnifex-brain';
export const BRAIN_MCP_READ_TOOLS = [
  'mcp__omnifex-brain__brain_search',
  'mcp__omnifex-brain__brain_read',
] as const;

export interface BrainMcpEnvironment {
  execPath: string;
  serverScript: string;
  userDataDir: string;
}
export function buildBrainServerConfig(vaultRoot: string, env: BrainMcpEnvironment): MCPServerConfig;
export function writeBrainSpawnConfig(accountId: number, vaultRoot: string, env: BrainMcpEnvironment): string;
export function brainSpawnArgs(configPath: string): string[];
export interface BrainMcpRegistration {
  isRegistered(configDir: string): boolean;
  register(configDir: string, vaultRoot: string): void;
  unregister(configDir: string): void;
}
export function createBrainMcpRegistration(mcp: MCPService, env: BrainMcpEnvironment): BrainMcpRegistration;
```

- [ ] **Step 1: Write the failing tests**

Create `electron/__tests__/brain-mcp-registration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMCPService } from '../services/mcp';
import {
  BRAIN_MCP_SERVER_NAME, BRAIN_MCP_READ_TOOLS,
  buildBrainServerConfig, writeBrainSpawnConfig, brainSpawnArgs,
  createBrainMcpRegistration,
} from '../services/brain/mcp-registration';

const env = (userDataDir: string) => ({
  execPath: '/Applications/OmniFex.app/Contents/MacOS/omnifex',
  serverScript: '/Applications/OmniFex.app/Contents/Resources/app.asar/.vite/build/brain-mcp.js',
  userDataDir,
});

describe('brain MCP registration', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'brain-reg-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('builds a config that runs Electron as node against one vault', () => {
    expect(buildBrainServerConfig('/vaults/personal', env(tmp))).toEqual({
      command: '/Applications/OmniFex.app/Contents/MacOS/omnifex',
      args: ['/Applications/OmniFex.app/Contents/Resources/app.asar/.vite/build/brain-mcp.js'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        OMNIFEX_VAULT: '/vaults/personal',
        OMNIFEX_BRAIN_DB: join('/vaults/personal', '.omnifex', 'index.db'),
      },
    });
  });

  it('writes the spawn config under userData, never into the vault', () => {
    const vault = join(tmp, 'vault');
    const path = writeBrainSpawnConfig(7, vault, env(tmp));
    expect(path.startsWith(tmp)).toBe(true);
    expect(path.includes(vault)).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mcpServers: { [BRAIN_MCP_SERVER_NAME]: buildBrainServerConfig(vault, env(tmp)) },
    });
  });

  it('rewrites the config when the vault moves', () => {
    const first = writeBrainSpawnConfig(7, join(tmp, 'one'), env(tmp));
    const second = writeBrainSpawnConfig(7, join(tmp, 'two'), env(tmp));
    expect(second).toBe(first);
    const written = JSON.parse(readFileSync(first, 'utf8'));
    expect(written.mcpServers[BRAIN_MCP_SERVER_NAME].env.OMNIFEX_VAULT).toBe(join(tmp, 'two'));
  });

  it('produces spawn args that merge rather than replace MCP config', () => {
    const args = brainSpawnArgs('/data/brain-mcp/7.json');
    expect(args).toEqual([
      '--mcp-config', '/data/brain-mcp/7.json',
      '--allowedTools', BRAIN_MCP_READ_TOOLS.join(','),
    ]);
    // --strict-mcp-config would suppress every other server the user configured.
    expect(args).not.toContain('--strict-mcp-config');
    // brain_remember stays a prompted, deliberate act.
    expect(args.join(' ')).not.toContain('brain_remember');
  });

  it('registers and fully unregisters in .claude.json', () => {
    const reg = createBrainMcpRegistration(createMCPService(), env(tmp));
    const configDir = join(tmp, 'cfg');
    expect(reg.isRegistered(configDir)).toBe(false);

    reg.register(configDir, '/vaults/personal');
    expect(reg.isRegistered(configDir)).toBe(true);
    const claudeJson = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8'));
    expect(claudeJson.mcpServers[BRAIN_MCP_SERVER_NAME].env.OMNIFEX_VAULT).toBe('/vaults/personal');
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
    expect(settings.permissions.allow).toEqual([...BRAIN_MCP_READ_TOOLS]);

    reg.unregister(configDir);
    expect(reg.isRegistered(configDir)).toBe(false);
    const after = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
    expect(after.permissions.allow).toEqual([]);
  });

  it('leaves the user\'s own permission rules alone', () => {
    const reg = createBrainMcpRegistration(createMCPService(), env(tmp));
    const configDir = join(tmp, 'cfg2');
    require('node:fs').mkdirSync(configDir, { recursive: true });
    require('node:fs').writeFileSync(join(configDir, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(git status)'] } }));

    reg.register(configDir, '/v');
    reg.unregister(configDir);
    const after = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
    expect(after.permissions.allow).toEqual(['Bash(git status)']);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run electron/__tests__/brain-mcp-registration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Read the permission docs before writing the rule code**

Read `docs/permission-syntax.md` and https://code.claude.com/docs/en/permissions. The rules here are bare MCP tool names (`mcp__<server>__<tool>`), which take no argument parentheses — but confirm that against the docs rather than this sentence. Every permissions regression in this repo came from assuming a rule format.

- [ ] **Step 4: Implement `electron/services/brain/mcp-registration.ts`**

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MCPServerConfig, MCPService } from '../mcp';

export const BRAIN_MCP_SERVER_NAME = 'omnifex-brain';

/**
 * Pre-allowed at spawn time and in the persistent registration. Retrieval is
 * read-only against the user's own vault, and a permission prompt on the first
 * search of every session is what stops a model using a memory tool at all.
 * `brain_remember` is deliberately absent: a write stays a deliberate act.
 */
export const BRAIN_MCP_READ_TOOLS = [
  `mcp__${BRAIN_MCP_SERVER_NAME}__brain_search`,
  `mcp__${BRAIN_MCP_SERVER_NAME}__brain_read`,
] as const;

export interface BrainMcpEnvironment {
  execPath: string;
  serverScript: string;
  userDataDir: string;
}

export function buildBrainServerConfig(vaultRoot: string, env: BrainMcpEnvironment): MCPServerConfig {
  return {
    command: env.execPath,
    args: [env.serverScript],
    env: {
      // Not system node: better-sqlite3 is built for the Electron ABI.
      ELECTRON_RUN_AS_NODE: '1',
      OMNIFEX_VAULT: vaultRoot,
      OMNIFEX_BRAIN_DB: join(vaultRoot, '.omnifex', 'index.db'),
    },
  };
}

/**
 * Written under userData rather than into the vault. It holds machine-specific
 * absolute paths including execPath, and a vault is a directory the user may
 * sync, open in Obsidian, or copy to another machine.
 */
export function writeBrainSpawnConfig(accountId: number, vaultRoot: string, env: BrainMcpEnvironment): string {
  const dir = join(env.userDataDir, 'brain-mcp');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${String(accountId)}.json`);
  writeFileSync(
    path,
    `${JSON.stringify({ mcpServers: { [BRAIN_MCP_SERVER_NAME]: buildBrainServerConfig(vaultRoot, env) } }, null, 2)}\n`,
    'utf8',
  );
  return path;
}

/** Never `--strict-mcp-config`: it would suppress every other server the user has. */
export function brainSpawnArgs(configPath: string): string[] {
  return ['--mcp-config', configPath, '--allowedTools', BRAIN_MCP_READ_TOOLS.join(',')];
}

export interface BrainMcpRegistration {
  isRegistered(configDir: string): boolean;
  register(configDir: string, vaultRoot: string): void;
  unregister(configDir: string): void;
}

interface SettingsShape { permissions?: { allow?: string[] } & Record<string, unknown> }

function readSettings(path: string): Record<string, unknown> & SettingsShape {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> & SettingsShape;
  } catch {
    return {};
  }
}

export function createBrainMcpRegistration(mcp: MCPService, env: BrainMcpEnvironment): BrainMcpRegistration {
  function settingsPath(configDir: string) { return join(configDir, 'settings.json'); }

  function setAllowRules(configDir: string, present: boolean): void {
    const path = settingsPath(configDir);
    const settings = readSettings(path);
    const permissions = { ...(settings.permissions ?? {}) };
    const current = Array.isArray(permissions.allow) ? permissions.allow : [];
    // Only ever add or remove OUR rules. The user's own list is untouched.
    const without = current.filter((r) => !BRAIN_MCP_READ_TOOLS.includes(r as never));
    permissions.allow = present ? [...without, ...BRAIN_MCP_READ_TOOLS] : without;
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify({ ...settings, permissions }, null, 2)}\n`, 'utf8');
  }

  return {
    isRegistered(configDir) {
      try {
        return mcp.list(configDir).some((s) => s.name === BRAIN_MCP_SERVER_NAME);
      } catch {
        return false;
      }
    },
    register(configDir, vaultRoot) {
      mcp.add({ name: BRAIN_MCP_SERVER_NAME, configDir, ...buildBrainServerConfig(vaultRoot, env) });
      setAllowRules(configDir, true);
    },
    unregister(configDir) {
      try {
        mcp.remove(BRAIN_MCP_SERVER_NAME, configDir);
      } catch {
        // Absent is the desired end state; removing what is not there is fine.
      }
      setAllowRules(configDir, false);
    },
  };
}
```

- [ ] **Step 5: Thread spawn args into the session spawn**

`electron/services/sessions/tui.ts`: add `extraArgs?: string[]` to `TuiSessionParams` and spread it after the session flag:

```ts
const args = [flag, params.sessionId, ...(params.extraArgs ?? [])];
```

`electron/services/sessions/lifecycle.ts`: add an optional dependency alongside the existing callbacks (`onSessionClosed`, `verifyAccountIdentity`, …):

```ts
/**
 * Extra CLI args for a session spawn, derived from its resolved configDir.
 * Returns [] when the account has no Brain vault. Injected rather than
 * computed here so the session layer keeps no knowledge of the Brain.
 */
extraSpawnArgs: ((configDir: string) => string[]) | null = null,
```

and pass `extraArgs: extraSpawnArgs?.(configDir) ?? []` at both `createTuiSession` call sites (~line 609 and ~line 794).

`electron/main.ts`: build the provider where accounts, brain and app paths are all in scope:

```ts
const brainMcpEnv = {
  execPath: process.execPath,
  serverScript: join(__dirname, 'brain-mcp.js'),
  userDataDir: app.getPath('userData'),
};
const brainSpawnArgsFor = (configDir: string): string[] => {
  try {
    const account = accountsService.getAccountByConfigDir(configDir);
    if (!account) return [];
    const vaultRoot = brainService?.vaultPath(account.id);
    if (!vaultRoot) return [];
    return brainSpawnArgs(writeBrainSpawnConfig(account.id, vaultRoot, brainMcpEnv));
  } catch (err) {
    // The Brain is auxiliary: a failure here must cost the Brain, not the session.
    console.warn('[main] brain spawn args unavailable:', err);
    return [];
  }
};
```

and pass it into the sessions service construction.

- [ ] **Step 6: Add the three IPC channels**

`electron/ipc/channels.ts`: add `'brain_mcp_status'`, `'brain_mcp_register'`, `'brain_mcp_unregister'` to the brain block.

`electron/ipc/brain-handlers.ts`: `createBrainHandlers(brain?, registration?, accounts?)` gains:

```ts
async brain_mcp_status(_event, params = {}) {
  const accountId = requireAccountId(params);
  const account = accounts?.listAccounts().find((a) => a.id === accountId);
  // A read: degrade rather than throw, per this file's module doc.
  if (!registration || !account) return { registered: false, available: false };
  return {
    registered: registration.isRegistered(account.config_dir),
    available: Boolean(brain?.vaultPath(accountId)),
  };
},

async brain_mcp_register(_event, params = {}) {
  if (!registration || !brain || !accounts) throw new Error('brain service unavailable');
  const accountId = requireAccountId(params);
  const account = accounts.listAccounts().find((a) => a.id === accountId);
  if (!account) throw new Error('no such account');
  const vaultRoot = brain.vaultPath(accountId);
  if (!vaultRoot) throw new Error('no vault configured for this account');
  registration.register(account.config_dir, vaultRoot);
  return null;
},

async brain_mcp_unregister(_event, params = {}) {
  if (!registration || !accounts) throw new Error('brain service unavailable');
  const account = accounts.listAccounts().find((a) => a.id === requireAccountId(params));
  if (!account) throw new Error('no such account');
  registration.unregister(account.config_dir);
  return null;
},
```

`src/lib/api.ts`:

```ts
export interface BrainMcpStatus { registered: boolean; available: boolean }

async brainMcpStatus(accountId: number): Promise<BrainMcpStatus> {
  return apiCall<BrainMcpStatus>('brain_mcp_status', { accountId });
},
async brainMcpRegister(accountId: number): Promise<void> {
  return apiCall<void>('brain_mcp_register', { accountId });
},
async brainMcpUnregister(accountId: number): Promise<void> {
  return apiCall<void>('brain_mcp_unregister', { accountId });
},
```

- [ ] **Step 7: Add IPC tests**

Append to `electron/__tests__/brain-ipc.test.ts`:

```ts
it('reports mcp status without a registration service', async () => {
  const handlers = createBrainHandlers(undefined, undefined, undefined);
  await expect(handlers.brain_mcp_status(null, { accountId: 1 }))
    .resolves.toEqual({ registered: false, available: false });
});

it('refuses to register an account with no vault', async () => {
  const handlers = createBrainHandlers(brain, registration, accounts);
  await expect(handlers.brain_mcp_register(null, { accountId: accountWithoutVault }))
    .rejects.toThrow(/no vault configured/);
});
```

- [ ] **Step 8: Run everything**

Run: `npx vitest run electron/__tests__/brain-mcp-registration.test.ts electron/__tests__/brain-ipc.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(brain): spawn-time MCP injection and a persistent per-account registration"
```

---

## Task 7: `/recall`

**Files:**
- Create: `src/lib/localSlashCommands.ts`, `src/components/brain/RecallDialog.tsx`, `src/components/__tests__/RecallDialog.test.tsx`
- Modify: `src/components/SlashCommandPicker.tsx`, `src/hooks/useSlashCommandAutocomplete.ts`, `src/components/FloatingPromptInput.tsx`
- Test: `src/components/__tests__/RecallDialog.test.tsx`, `src/hooks/__tests__/useSlashCommandAutocomplete.test.tsx`

**Interfaces:**
- Consumes: `api.brainSearch`, `api.brainReadNote`, `api.brainStatus`, `SlashCommand`.
- Produces:

```ts
export const RECALL_COMMAND_ID = 'omnifex:brain:recall';
export function localSlashCommands(opts: { hasVault: boolean }): SlashCommand[];
export function isLocalSlashCommand(id: string): boolean;
export function formatRecalledNotes(notes: { path: string; body: string }[]): string;
```

- [ ] **Step 1: Write the failing tests**

Create `src/components/__tests__/RecallDialog.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { localSlashCommands, isLocalSlashCommand, formatRecalledNotes, RECALL_COMMAND_ID }
  from '@/lib/localSlashCommands';

describe('local slash commands', () => {
  it('offers /recall only when the account has a vault', () => {
    expect(localSlashCommands({ hasVault: true }).map((c) => c.id)).toEqual([RECALL_COMMAND_ID]);
    expect(localSlashCommands({ hasVault: false })).toEqual([]);
  });

  it('identifies its own commands', () => {
    expect(isLocalSlashCommand(RECALL_COMMAND_ID)).toBe(true);
    expect(isLocalSlashCommand('user:default:commit')).toBe(false);
  });

  it('formats recalled notes with their paths, whole', () => {
    expect(formatRecalledNotes([
      { path: 'Subsystems/Queue.md', body: 'the drain worker' },
      { path: 'Topics/Pty.md', body: 'node-pty leak' },
    ])).toBe(
      '<recalled-notes>\n' +
      '### Subsystems/Queue.md\n\nthe drain worker\n\n' +
      '### Topics/Pty.md\n\nnode-pty leak\n' +
      '</recalled-notes>\n\n'
    );
  });

  it('returns empty string for no selection, so nothing is inserted', () => {
    expect(formatRecalledNotes([])).toBe('');
  });
});
```

Append to `src/hooks/__tests__/useSlashCommandAutocomplete.test.tsx`:

```tsx
it('dispatches a local command to its handler instead of inserting text', () => {
  const setPrompt = vi.fn();
  const onLocal = vi.fn();
  const { result } = renderHook(() => useSlashCommandAutocomplete({ onLocalCommand: onLocal }));

  act(() => {
    result.current.handleSlashCommandSelect(
      { id: RECALL_COMMAND_ID, name: 'recall', full_command: '/recall', scope: 'omnifex' } as SlashCommand,
      '/rec', 4, setPrompt, null,
    );
  });

  expect(onLocal).toHaveBeenCalledWith(RECALL_COMMAND_ID);
  expect(setPrompt).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/components/__tests__/RecallDialog.test.tsx src/hooks/__tests__/useSlashCommandAutocomplete.test.tsx`
Expected: FAIL — `@/lib/localSlashCommands` not found.

- [ ] **Step 3: Implement `src/lib/localSlashCommands.ts`**

```ts
import type { SlashCommand } from '@/lib/api';

export const RECALL_COMMAND_ID = 'omnifex:brain:recall';

/**
 * Commands OmniFex itself provides. Deliberately NOT written into
 * `<configDir>/commands/` — the Brain leaves no residue in the user's Claude
 * config (spec §15). A lookup rather than a special case, so the second local
 * command is not bolted onto the first.
 */
export function localSlashCommands(opts: { hasVault: boolean }): SlashCommand[] {
  if (!opts.hasVault) return [];
  return [{
    id: RECALL_COMMAND_ID,
    name: 'recall',
    full_command: '/recall',
    description: 'Search this account\'s Brain and insert notes into the prompt',
    scope: 'omnifex',
    namespace: 'brain',
    accepts_arguments: false,
    has_bash_commands: false,
allowed_tools: [],
  } as SlashCommand];
}

export function isLocalSlashCommand(id: string): boolean {
  return id === RECALL_COMMAND_ID;
}

export function formatRecalledNotes(notes: { path: string; body: string }[]): string {
  if (notes.length === 0) return '';
  const blocks = notes.map((n) => `### ${n.path}\n\n${n.body}\n`).join('\n');
  return `<recalled-notes>\n${blocks}</recalled-notes>\n\n`;
}
```

Match the real `SlashCommand` field names in `src/lib/api.ts` — adjust the object literal to whatever that interface actually declares, and drop the `as SlashCommand` cast once it typechecks without one.

- [ ] **Step 4: Add the local-command seam**

`useSlashCommandAutocomplete.ts`: accept `{ onLocalCommand }` and branch at the top of `handleSlashCommandSelect`:

```ts
if (isLocalSlashCommand(command.id)) {
  setShowSlashCommandPicker(false);
  setSlashCommandQuery('');
  onLocalCommand?.(command.id);
  return;
}
```

`SlashCommandPicker.tsx`: merge `localSlashCommands({ hasVault })` into the command list it builds, and badge `scope === 'omnifex'` rows the way CLI-sourced rows are badged.

`FloatingPromptInput.tsx`: pass `hasVault` (from `api.brainStatus` for the tab's account) to the picker, pass `onLocalCommand` to the hook, and render `<RecallDialog>` when the id is `RECALL_COMMAND_ID`.

- [ ] **Step 5: Implement `RecallDialog.tsx`**

A dialog with a search input calling `api.brainSearch(accountId, query)`, a checkbox list of hits (path, title, snippet), and an Insert button that `await`s `api.brainReadNote(accountId, path)` for each selection and calls `onInsert(formatRecalledNotes(...))`.

Because it renders inside a Radix `Dialog` and this repo has been bitten by portal/dismiss interactions before, mark any popover it contains with `data-omnifex-popover` and guard `onInteractOutside` — see `project_popover_in_dialog` and the existing pattern in the Brain tab.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/`
Expected: PASS.

Run: `npm run check && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(brain): /recall inserts vault notes into the prompt"
```

---

## Task 8: The persistent-registration toggle in the Brain tab

**Files:**
- Modify: `src/components/brain/BrainQueuePanel.tsx`
- Test: `src/components/__tests__/BrainQueuePanel.test.tsx`

**Interfaces:**
- Consumes: `api.brainMcpStatus`, `api.brainMcpRegister`, `api.brainMcpUnregister`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `src/components/__tests__/BrainQueuePanel.test.tsx`:

```tsx
it('shows the Claude-exposure toggle as off and enables it on click', async () => {
  vi.mocked(api.brainMcpStatus).mockResolvedValue({ registered: false, available: true });
  render(<BrainQueuePanel accountId={1} />);

  const toggle = await screen.findByRole('switch', { name: /outside omnifex/i });
  expect(toggle).toHaveAttribute('aria-checked', 'false');

  fireEvent.click(toggle);
  await waitFor(() => { expect(api.brainMcpRegister).toHaveBeenCalledWith(1); });
});

it('hides the toggle for an account with no vault', async () => {
  vi.mocked(api.brainMcpStatus).mockResolvedValue({ registered: false, available: false });
  render(<BrainQueuePanel accountId={1} />);
  await waitFor(() => { expect(api.brainMcpStatus).toHaveBeenCalled(); });
  expect(screen.queryByRole('switch', { name: /outside omnifex/i })).toBeNull();
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/components/__tests__/BrainQueuePanel.test.tsx`
Expected: FAIL — no such switch.

- [ ] **Step 3: Implement**

Add a third switch beside the existing auto-index and pause switches, labelled **"Expose the Brain to Claude outside OmniFex"** with the helper text *"Sessions started from OmniFex already get it. This writes the server into this account's Claude config so terminal sessions do too."* Load state from `api.brainMcpStatus(accountId)` on mount and on account change; render nothing when `available` is false.

Unlike the two global switches, this one is **per account** — so it re-reads on account change rather than once on mount.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/components/__tests__/BrainQueuePanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(brain): per-account toggle for persistent MCP registration"
```

---

## Task 9: Full verification and live proof

**Files:**
- Modify: `docs/superpowers/plans/2026-08-11-brain-vault-followups.md` (record what this plan opened)

- [ ] **Step 1: Run the gate**

```bash
npm run check
npm run build
npm run test:coverage
```

Expected: all pass. Record the coverage number for `electron/services/brain/**`.

- [ ] **Step 2: Rebuild the native modules for Electron**

```bash
npm run rebuild:electron
```

Expected: `verified: native modules at NMV 145 (Electron ABI)`.

- [ ] **Step 3: Prove it live**

Start the app, confirm a session under an account with a vault, and ask it to search the Brain. Then verify the capture round trip:

1. Ask the session to `brain_remember` a fact.
2. Confirm a JSON file appeared in `<vault>/.omnifex/capture/`.
3. Close the session, run Drain now from the Brain tab.
4. Confirm the fact became or updated a note, and that the note's `sources` contains `capture:<id>`.

- [ ] **Step 4: Record findings**

Append an "Opened by Plan 5" section to `docs/superpowers/plans/2026-08-11-brain-vault-followups.md` with what the live run showed — especially whether the model reached for `brain_search` unprompted, which is the one thing no test can cover.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: record Plan 5's live verification"
```

---

## Notes (fill in during execution)

- Task 3 smoke test result:
- Task 9 coverage number:
- Did the model call `brain_search` without being told to?
