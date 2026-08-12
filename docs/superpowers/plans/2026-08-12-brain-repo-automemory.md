# Brain Plan 6 — repo-artifact and auto-memory adapters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the last two v1 sources — auto-memory notes ingested with no model at all, and repo `CLAUDE.md` / `AGENTS.md` files extracted like any other source.

**Architecture:** `BrainSource` gains an optional `translate()` that returns finished notes; `indexSource` branches on it once and skips the extractor entirely, keeping the gate, change detection, git commit and queue unchanged. The auto-memory adapter translates; the repo-artifact adapter distills and extracts. Both enqueue on session close for that project.

**Tech Stack:** TypeScript, Electron, `better-sqlite3`, `js-yaml`, `zod`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-12-brain-repo-automemory-design.md`

## Global Constraints

- **Branch:** `feat/brain-repo-automemory`, already created. No git worktrees for this repo (`CLAUDE.md`).
- **TDD is required.** Failing test first, then implementation. Backend target 80% lines.
- **Backend tests** live in `electron/__tests__/*.test.ts`.
- **Ownership rules are not negotiable:** auto-memory is owned by the config dir it lives under; repo artifacts by `resolve()` on the repo path (explicit override → longest path rule → `null`). No silent default-account fallback anywhere.
- **The Brain is auxiliary:** nothing here may break a session, block the UI, or crash main.
- **A translating source spends no tokens.** It must work with no extractor and no `configDir`.
- **Verification gate:** `npm run check`, `npm run build`, `npm run test:coverage`, then `npm run rebuild:electron` — vitest leaves `better-sqlite3` on the Node ABI.
- **Run `npm rebuild better-sqlite3` before `npx vitest`** if a run fails with `NODE_MODULE_VERSION 145 … requires 127`. `npm test` does this via its pretest hook; a bare `npx vitest` does not.

### Verified facts (measured 2026-08-12 — do not re-derive)

- **102 auto-memory files** exist: 93 under `~/.claude-personal`, 9 under `~/.claude-work`, across 15 project directories.
- Auto-memory frontmatter is `name`, `description`, `metadata: { type, node_type, originSessionId }`. The body carries `[[wikilinks]]` that include the `.md` suffix.
- `linkMatchesNote` (`electron/services/brain/links.ts:40`) compares final segments case-insensitively **with `.md` stripped**, so `[[project_native_module_abi.md]]` binds to `Notes/project_native_module_abi.md`. Keeping slugs as filenames preserves the whole existing link graph.
- **The encoded project directory name is lossy and must never be decoded.** The CLI replaces every non-alphanumeric character with `-`, so `-Users-gregorychristie-Repos-personal-wombeats-ios` naively decodes to `/Users/…/wombeats/ios`, which does not exist; the real repo is `/Users/…/wombeats-ios`. Read the repo path from a transcript's `cwd` instead.
- Path rules in the live DB: `~/Repos/personal` → account 1 (Personal), `~/Repos/work` → account 2 (Work). So `resolve()` succeeds for effectively every repo.
- `AccountsService.resolve(projectPath)` returns a `ResolvePair` — use `.claude?.account`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `electron/services/brain/sources/auto-memory.ts` | The auto-memory `BrainSource` plus its pure `translateAutoMemory`. |
| `electron/services/brain/sources/repo-artifacts.ts` | The repo-artifact `BrainSource` plus `repoPathFromTranscript`. |
| `electron/__tests__/brain-auto-memory-source.test.ts` | Translation purity, mapping, isolation. |
| `electron/__tests__/brain-repo-artifact-source.test.ts` | Discovery, the lossy-name trap, `resolve()` ownership. |

**Modified:**

| File | Change |
|---|---|
| `electron/services/brain/sources/types.ts` | `TranslatedNote`, optional `translate()`, `ArtifactMetadata` arm. |
| `electron/services/brain/registry.ts` | `indexSource` branches on `translate()`. |
| `electron/services/brain/extract.ts` | `artifact` arm in the prompt. |
| `electron/main.ts` | Construct both sources; extend the close-time enqueue. |

---

## Task 1: The `translate()` seam

**Files:**
- Modify: `electron/services/brain/sources/types.ts`, `electron/services/brain/registry.ts`
- Test: `electron/__tests__/brain-registry.test.ts`

**Interfaces:**
- Consumes: `BrainSource`, `SourceItem`, `ParsedNote`, existing `indexSource`.
- Produces:

```ts
/** A finished note and where it goes, built with no model. */
export interface TranslatedNote {
  /** Vault-relative, e.g. "Notes/project_nodepty_pty_leak.md". */
  relPath: string;
  note: ParsedNote;
}

// added to BrainSource:
/**
 * Notes built with NO model. A source implements this OR `distill()`.
 * When present, `indexSource` skips extraction entirely — no extractor, no
 * owning-account config dir, no tokens.
 */
translate?(item: SourceItem): Promise<TranslatedNote[]>;
```

- [ ] **Step 1: Write the failing tests**

Append to `electron/__tests__/brain-registry.test.ts`. Use the file's existing service/vault helpers; the source below is a local fake:

```ts
describe('translating sources', () => {
  /** A source that produces notes with no model, like auto-memory. */
  function fakeTranslator(accountId: number, notes: TranslatedNote[]): BrainSource {
    return {
      id: 'fake-translate',
      discover: () => Promise.resolve([{
        sourceId: 'fake-translate', itemKey: 'item-1', accountId,
        path: '/tmp/fake-item-1', mtimeMs: 1, size: 10, label: 'fake',
      }]),
      admit: () => ({ admitted: true, reason: 'ok' }),
      translate: () => Promise.resolve(notes),
    };
  }

  const NOTE: ParsedNote = {
    frontmatter: {
      type: 'Note', aliases: [], keywords: [],
      created: '2026-08-12', updated: '2026-08-12',
      sources: ['auto-memory:proj/x.md'],
    },
    body: '## Summary\n\ntranslated body\n',
  };

  it('writes translated notes without an extractor', async () => {
    // A service built with NO extractor at all: a translating source must not
    // need one, which is the whole point of the seam.
    const brain = createBrainService(db, {
      execGit: stubExec,
      accounts: accountsStub,
      sources: [fakeTranslator(1, [{ relPath: 'Notes/x.md', note: NOTE }])],
    });
    brain.setVaultPath(1, join(dir, 'v1'));

    const result = await brain.indexSource(1, 'item-1');

    expect(result.skipped).toBe(false);
    expect(result.notesWritten).toEqual(['Notes/x.md']);
    expect(brain.open(1)!.vault.readNote('Notes/x.md').body).toContain('translated body');
    brain.closeAll();
  });

  it('never calls the extractor for a translating source', async () => {
    let called = 0;
    const brain = createBrainService(db, {
      execGit: stubExec,
      accounts: accountsStub,
      extractor: () => { called += 1; return Promise.resolve({ entities: [] }); },
      sources: [fakeTranslator(1, [{ relPath: 'Notes/x.md', note: NOTE }])],
    });
    brain.setVaultPath(1, join(dir, 'v2'));

    await brain.indexSource(1, 'item-1');

    expect(called).toBe(0);
    brain.closeAll();
  });

  it('indexes a translated note for search', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [fakeTranslator(1, [{ relPath: 'Notes/x.md', note: NOTE }])],
    });
    brain.setVaultPath(1, join(dir, 'v3'));
    await brain.indexSource(1, 'item-1');

    expect(brain.search(1, 'translated').map((h) => h.notePath)).toEqual(['Notes/x.md']);
    brain.closeAll();
  });

  it('still honours the gate and the unchanged short-circuit', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [fakeTranslator(1, [{ relPath: 'Notes/x.md', note: NOTE }])],
    });
    brain.setVaultPath(1, join(dir, 'v4'));

    await brain.indexSource(1, 'item-1');
    const second = await brain.indexSource(1, 'item-1');

    expect(second.skipped).toBe(true);
    expect(second.reason).toMatch(/unchanged/);
    brain.closeAll();
  });

  it('isolates a failing note to that note', async () => {
    const brain = createBrainService(db, {
      execGit: stubExec, accounts: accountsStub,
      sources: [fakeTranslator(1, [
        // A path with a separator that vault.writeNote rejects, beside a good one.
        { relPath: '../escape.md', note: NOTE },
        { relPath: 'Notes/good.md', note: NOTE },
      ])],
    });
    brain.setVaultPath(1, join(dir, 'v5'));

    const result = await brain.indexSource(1, 'item-1');

    expect(result.notesWritten).toEqual(['Notes/good.md']);
    expect(result.reason).toMatch(/escape/);
    brain.closeAll();
  });
});
```

`accountsStub` is whatever the file already uses for `AccountsService`; if it has none, add:

```ts
const accountsStub = {
  listAccounts: () => [{ id: 1, config_dir: join(dir, 'cfg1') }],
} as unknown as AccountsService;
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run electron/__tests__/brain-registry.test.ts`
Expected: FAIL — `translate` is not a property of `BrainSource`, and `indexSource` throws `brain: no extractor configured`.

- [ ] **Step 3: Add the types**

In `electron/services/brain/sources/types.ts`:

```ts
import type { ParsedNote } from '../types';

/**
 * A finished note and where it goes, built with no model.
 *
 * The path is chosen by the ADAPTER, not by `resolveEntityPath`: a translated
 * note is a projection of one source file, not an entity that other sources
 * merge into, so folding it into a same-named entity note would silently blend
 * two different kinds of provenance.
 */
export interface TranslatedNote {
  /** Vault-relative, e.g. "Notes/project_nodepty_pty_leak.md". */
  relPath: string;
  note: ParsedNote;
}
```

and on `BrainSource`:

```ts
  /**
   * Notes built with NO model. A source implements this OR `distill()`.
   *
   * When present, `indexSource` skips extraction entirely — no extractor, no
   * owning-account config dir, no tokens. The gate, change detection, the git
   * commit and the queue are unchanged.
   */
  translate?(item: SourceItem): Promise<TranslatedNote[]>;
```

`distill` becomes optional on the interface (`distill?(item)`), since a
translating source has no use for it. `indexSource` already fails loudly for a
source that offers neither.

- [ ] **Step 4: Branch `indexSource`**

In `registry.ts`, inside `indexSource`, after the gate and the unchanged
short-circuit and after `requireHandle(accountId)`, insert the translating path
BEFORE the account lookup and the `distill`/extractor calls:

```ts
      // A translating source produces finished notes with no model, so it
      // needs neither an extractor nor an owning-account config dir. Branch
      // before both: requiring an account here would block a source that
      // cannot spend anything through the wrong subscription anyway.
      if (source.translate) {
        const translated = await source.translate(item);
        const written: string[] = [];
        const failures: string[] = [];
        for (const { relPath, note } of translated) {
          try {
            // The source file is the authority for a translated note: it is a
            // projection, and re-translating overwrites. Change detection means
            // that only happens when the source file actually changed.
            handle.vault.writeNote(relPath, note);
            handle.index.upsert(relPath, handle.vault.noteTitle(relPath), note);
            written.push(relPath);
          } catch (err) {
            failures.push(`${relPath}: ${(err as Error).message}`);
          }
        }
        const summary = failures.length > 0 ? failures.join('; ') : undefined;
        if (written.length > 0) {
          commitAndRecord(handle, `Index ${item.sourceId}:${item.itemKey}`);
        }
        if (written.length === 0 && failures.length > 0) {
          sourceState.record(item, { status: 'failed', error: summary });
          return { itemKey, notesWritten: [], skipped: true, reason: summary ?? 'no notes written' };
        }
        sourceState.record(item, { status: 'indexed', error: summary });
        return {
          itemKey,
          notesWritten: written,
          skipped: false,
          reason:
            failures.length > 0
              ? `${String(written.length)} note(s) written, ${String(failures.length)} failed: ${summary ?? ''}`
              : `${String(written.length)} note(s) written`,
        };
      }
```

Then guard the extracting path so a source with neither method fails clearly.
Replace the existing early `if (!opts.extractor) throw …` at the top of
`indexSource` with a check placed after the translate branch:

```ts
      if (!source.distill) throw new Error(`brain: source ${source.sourceId} cannot produce notes`);
      if (!opts.extractor) throw new Error('brain: no extractor configured');
```

Note the property is `item.sourceId`; use `source.id` if reading from the
source object.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run electron/__tests__/brain-registry.test.ts electron/__tests__/brain-ipc.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/services/brain/sources/types.ts electron/services/brain/registry.ts electron/__tests__/brain-registry.test.ts
git commit -m "feat(brain): a source may translate notes instead of extracting them"
```

---

## Task 2: Auto-memory adapter

**Files:**
- Create: `electron/services/brain/sources/auto-memory.ts`
- Test: `electron/__tests__/brain-auto-memory-source.test.ts`

**Interfaces:**
- Consumes: `TranslatedNote`, `BrainSource`, `AccountsService`, `parseNote`-adjacent YAML handling (`js-yaml`'s `load`).
- Produces:

```ts
export const AUTO_MEMORY_SOURCE_ID = 'auto-memory';

export interface AutoMemoryFile {
  name: string;
  description: string;
  /** `user` | `feedback` | `project` | `reference`, or '' when absent. */
  memoryType: string;
  body: string;
}

/** Pure. Throws nothing — returns null for anything unusable. */
export function parseAutoMemory(raw: string, fallbackName: string): AutoMemoryFile | null;

export function translateAutoMemory(
  file: AutoMemoryFile,
  opts: { sourceKey: string; date: string },
): TranslatedNote;

export function createAutoMemorySource(deps: { accounts: AccountsService }): BrainSource;
```

- [ ] **Step 1: Write the failing tests**

Create `electron/__tests__/brain-auto-memory-source.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AccountsService } from '../services/accounts';
import {
  createAutoMemorySource,
  parseAutoMemory,
  translateAutoMemory,
} from '../services/brain/sources/auto-memory';

/** A redacted copy of a real auto-memory file — the format is the premise. */
const REAL = `---
name: project_nodepty_pty_leak
description: Why node-pty is pinned to 1.2.0-beta.13 — fixes a pty leak
metadata:
  node_type: memory
  type: project
  originSessionId: ff79cd97-3318-4405-abbb-d20398bfc778
---

node-pty is pinned to **1.2.0-beta.13** (exact, not \`^\`).

**Why:** stable 1.1.0 leaks a pty master fd per spawn.

Related: [[project_native_module_abi.md]], [[feedback_electron_rebuild_after_tests.md]]
`;

function writeMemory(configDir: string, project: string, file: string, contents: string) {
  const dir = join(configDir, 'projects', project, 'memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), contents, 'utf8');
}

describe('parseAutoMemory', () => {
  it('reads name, description, type and body', () => {
    const parsed = parseAutoMemory(REAL, 'fallback');
    expect(parsed).toMatchObject({
      name: 'project_nodepty_pty_leak',
      description: 'Why node-pty is pinned to 1.2.0-beta.13 — fixes a pty leak',
      memoryType: 'project',
    });
    expect(parsed!.body).toContain('**Why:**');
  });

  it('falls back to the filename stem when name is missing', () => {
    const parsed = parseAutoMemory('---\ndescription: d\n---\n\nbody\n', 'some_file');
    expect(parsed?.name).toBe('some_file');
  });

  it('returns null for a file with no frontmatter fence', () => {
    expect(parseAutoMemory('just prose\n', 'x')).toBeNull();
  });

  it('returns null for malformed YAML', () => {
    expect(parseAutoMemory('---\nname: [unclosed\n---\nbody\n', 'x')).toBeNull();
  });

  it('returns null for an empty body', () => {
    expect(parseAutoMemory('---\nname: n\n---\n\n   \n', 'x')).toBeNull();
  });
});

describe('translateAutoMemory', () => {
  const file = parseAutoMemory(REAL, 'x')!;
  const translated = translateAutoMemory(file, {
    sourceKey: 'auto-memory:-Users-dev-repo/project_nodepty_pty_leak.md',
    date: '2026-08-12',
  });

  it('keeps the slug as the filename so existing wikilinks still bind', () => {
    // linkMatchesNote compares final segments with .md stripped, so
    // [[project_native_module_abi.md]] resolves only if slugs are preserved.
    expect(translated.relPath).toBe('Notes/project_nodepty_pty_leak.md');
  });

  it('maps description to a Summary section and keeps the body verbatim', () => {
    expect(translated.note.body).toContain('## Summary');
    expect(translated.note.body).toContain('Why node-pty is pinned');
    expect(translated.note.body).toContain('**Why:** stable 1.1.0 leaks');
    expect(translated.note.body).toContain('[[project_native_module_abi.md]]');
  });

  it('records the memory type as an alias and the note type as Note', () => {
    expect(translated.note.frontmatter.type).toBe('Note');
    expect(translated.note.frontmatter.aliases).toContain('project');
  });

  it('never puts the origin session in sources', () => {
    // merge() dedups by source key: a Note claiming session:ff79cd97 would make
    // a later index of that transcript believe it was already covered, and the
    // session's own note would never be written.
    expect(translated.note.frontmatter.sources).toEqual([
      'auto-memory:-Users-dev-repo/project_nodepty_pty_leak.md',
    ]);
    expect(JSON.stringify(translated.note.frontmatter)).not.toContain('ff79cd97');
  });

  it('is byte-identical on a second translation', () => {
    const again = translateAutoMemory(parseAutoMemory(REAL, 'x')!, {
      sourceKey: 'auto-memory:-Users-dev-repo/project_nodepty_pty_leak.md',
      date: '2026-08-12',
    });
    expect(again).toEqual(translated);
  });
});

describe('auto-memory source', () => {
  let tmp: string;
  let personal: string;
  let work: string;
  let source: ReturnType<typeof createAutoMemorySource>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brain-automem-'));
    personal = join(tmp, 'cfg-personal');
    work = join(tmp, 'cfg-work');
    const accounts = {
      listAccounts: () => [
        { id: 1, config_dir: personal },
        { id: 2, config_dir: work },
      ],
    } as unknown as AccountsService;
    source = createAutoMemorySource({ accounts });
  });

  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('owns a file by the config dir it lives under', async () => {
    writeMemory(personal, '-repo-a', 'a.md', REAL);
    writeMemory(work, '-repo-b', 'b.md', REAL);

    const items = await source.discover();
    expect(items.map((i) => [i.accountId, i.itemKey]).sort()).toEqual([
      [1, '-repo-a/a.md'],
      [2, '-repo-b/b.md'],
    ]);
  });

  it('skips MEMORY.md, which is an index of its siblings', async () => {
    writeMemory(personal, '-repo-a', 'MEMORY.md', '- [A](a.md) — hook\n');
    writeMemory(personal, '-repo-a', 'a.md', REAL);

    const items = await source.discover();
    expect(items.map((i) => i.itemKey)).toEqual(['-repo-a/a.md']);
  });

  it('admits a well-formed memory and rejects a broken one', async () => {
    writeMemory(personal, '-repo-a', 'good.md', REAL);
    writeMemory(personal, '-repo-a', 'bad.md', 'no frontmatter here\n');

    const items = await source.discover();
    const verdicts = Object.fromEntries(
      items.map((i) => [i.itemKey, source.admit(i)]),
    );
    expect(verdicts['-repo-a/good.md'].admitted).toBe(true);
    expect(verdicts['-repo-a/bad.md'].admitted).toBe(false);
    expect(verdicts['-repo-a/bad.md'].reason).toMatch(/frontmatter|unreadable/i);
  });

  it('translates into Notes/ with the source key of its own file', async () => {
    writeMemory(personal, '-repo-a', 'project_nodepty_pty_leak.md', REAL);
    const [item] = await source.discover();

    const notes = await source.translate!(item);
    expect(notes).toHaveLength(1);
    expect(notes[0].relPath).toBe('Notes/project_nodepty_pty_leak.md');
    expect(notes[0].note.frontmatter.sources).toEqual([
      'auto-memory:-repo-a/project_nodepty_pty_leak.md',
    ]);
  });

  it('offers no distill — it must never reach the extractor', () => {
    expect(source.distill).toBeUndefined();
  });

  it('reports nothing when no account has a memory directory', async () => {
    expect(await source.discover()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run electron/__tests__/brain-auto-memory-source.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `electron/services/brain/sources/auto-memory.ts`:

```ts
/**
 * Claude Code's own auto-memory notes, ingested with NO model.
 *
 * These files are already what the vault wants — frontmatter, a description,
 * curated prose and `[[wikilinks]]`. Running them through the extractor would
 * spend a token to rewrite writing a human deliberately curated, and lose the
 * exact wording doing it. Extraction earns its cost on a megabyte of
 * transcript; here it destroys value.
 *
 * OmniFex never writes into a Claude config dir. This reads, only.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import type { AccountsService } from '../../accounts';
import type { AdmitVerdict, BrainSource, SourceItem, TranslatedNote } from './types';

export const AUTO_MEMORY_SOURCE_ID = 'auto-memory';

/** The index file, which lists every sibling. Ingesting it duplicates them all. */
const INDEX_FILE = 'MEMORY.md';

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface AutoMemoryFile {
  name: string;
  description: string;
  memoryType: string;
  body: string;
}

/** Pure, and never throws: anything unusable is null, which `admit` reports. */
export function parseAutoMemory(raw: string, fallbackName: string): AutoMemoryFile | null {
  const match = FENCE.exec(raw);
  if (!match) return null;

  let loaded: unknown;
  try {
    loaded = load(match[1]) ?? {};
  } catch {
    return null;
  }
  if (typeof loaded !== 'object' || loaded === null) return null;

  const fm = loaded as { name?: unknown; description?: unknown; metadata?: unknown };
  const metadata = (typeof fm.metadata === 'object' && fm.metadata !== null
    ? fm.metadata
    : {}) as { type?: unknown };

  const body = match[2].trim();
  if (!body) return null;

  return {
    name: typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : fallbackName,
    description: typeof fm.description === 'string' ? fm.description.trim() : '',
    memoryType: typeof metadata.type === 'string' ? metadata.type : '',
    body,
  };
}

/**
 * One memory file becomes one note in `Notes/`.
 *
 * The slug stays the filename. It is an ugly title, but `linkMatchesNote`
 * binds a target by final segment with `.md` stripped, so preserving slugs
 * keeps the corpus's existing link graph intact. Humanising titles would
 * silently break every `[[…]]` in it.
 */
export function translateAutoMemory(
  file: AutoMemoryFile,
  opts: { sourceKey: string; date: string },
): TranslatedNote {
  const summary = file.description || 'Ingested from Claude Code auto-memory.';
  return {
    relPath: `Notes/${file.name}.md`,
    note: {
      frontmatter: {
        type: 'Note',
        // The memory's own type is a searchable alias rather than a vault
        // type: `feedback` and `reference` have no NOTE_TYPES equivalent, and
        // inventing one would fork the ontology for four values.
        aliases: file.memoryType ? [file.memoryType] : [],
        keywords: [],
        created: opts.date,
        updated: opts.date,
        sources: [opts.sourceKey],
      },
      body: `## Summary\n\n${summary}\n\n${file.body}\n`,
    },
  };
}

function listDirSafe(path: string): { name: string; isDirectory: boolean }[] {
  try {
    return readdirSync(path, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    }));
  } catch {
    // A config dir with no projects yet is the ordinary state of a new
    // account, not an error.
    return [];
  }
}

export function createAutoMemorySource(deps: { accounts: AccountsService }): BrainSource {
  function read(item: SourceItem): AutoMemoryFile | null {
    const stem = item.itemKey.split('/').pop()?.replace(/\.md$/, '') ?? item.itemKey;
    try {
      return parseAutoMemory(readFileSync(item.path, 'utf8'), stem);
    } catch {
      return null;
    }
  }

  return {
    id: AUTO_MEMORY_SOURCE_ID,

    discover(): Promise<SourceItem[]> {
      const items: SourceItem[] = [];
      for (const account of deps.accounts.listAccounts()) {
        const projectsDir = join(account.config_dir, 'projects');
        for (const project of listDirSafe(projectsDir)) {
          if (!project.isDirectory) continue;
          const memoryDir = join(projectsDir, project.name, 'memory');
          for (const entry of listDirSafe(memoryDir)) {
            if (entry.isDirectory) continue;
            if (!entry.name.endsWith('.md')) continue;
            if (entry.name === INDEX_FILE) continue;

            const path = join(memoryDir, entry.name);
            let stat;
            try {
              stat = statSync(path);
            } catch {
              continue; // Deleted between readdir and stat.
            }
            items.push({
              sourceId: AUTO_MEMORY_SOURCE_ID,
              // Project-qualified: a slug like `user_setup` recurs across
              // projects, and an unqualified key would collide.
              itemKey: `${project.name}/${entry.name}`,
              accountId: account.id,
              path,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              label: project.name,
            });
          }
        }
      }
      return Promise.resolve(items);
    },

    admit(item: SourceItem): AdmitVerdict {
      const file = read(item);
      if (!file) return { admitted: false, reason: 'unreadable, or no YAML frontmatter fence' };
      return { admitted: true, reason: 'auto-memory note' };
    },

    translate(item: SourceItem): Promise<TranslatedNote[]> {
      const file = read(item);
      if (!file) return Promise.resolve([]);
      return Promise.resolve([
        translateAutoMemory(file, {
          sourceKey: `${AUTO_MEMORY_SOURCE_ID}:${item.itemKey}`,
          date: new Date(item.mtimeMs).toISOString().slice(0, 10),
        }),
      ]);
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run electron/__tests__/brain-auto-memory-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/brain/sources/auto-memory.ts electron/__tests__/brain-auto-memory-source.test.ts
git commit -m "feat(brain): ingest Claude Code auto-memory with no model"
```

---

## Task 3: Repo-artifact adapter

**Files:**
- Create: `electron/services/brain/sources/repo-artifacts.ts`
- Modify: `electron/services/brain/sources/types.ts`, `electron/services/brain/extract.ts`
- Test: `electron/__tests__/brain-repo-artifact-source.test.ts`, `electron/__tests__/brain-extract.test.ts`

**Interfaces:**
- Consumes: `AccountsService.resolve`, `SourceItem`, `DistilledItem`, `ItemMetadata`.
- Produces:

```ts
export const REPO_SOURCE_ID = 'repo';

/** The repo path a project directory's transcripts actually ran in, or null. */
export function repoPathFromTranscripts(
  projectDir: string,
  readChunk?: (path: string) => string,
): string | null;

export function createRepoArtifactSource(deps: { accounts: AccountsService }): BrainSource;

// added to ItemMetadata in sources/types.ts:
export interface ArtifactMetadata {
  repoPath: string;
  /** Repo-relative, e.g. "CLAUDE.md" or "src/CLAUDE.md". */
  file: string;
}
// | ({ kind: 'artifact' } & ArtifactMetadata)
```

- [ ] **Step 1: Write the failing tests**

Create `electron/__tests__/brain-repo-artifact-source.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AccountsService } from '../services/accounts';
import {
  createRepoArtifactSource,
  repoPathFromTranscripts,
} from '../services/brain/sources/repo-artifacts';

function writeTranscript(configDir: string, project: string, name: string, cwd: string | null) {
  const dir = join(configDir, 'projects', project);
  mkdirSync(dir, { recursive: true });
  const rows = [
    JSON.stringify({ type: 'summary', summary: 'no cwd on this row' }),
    ...(cwd ? [JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hi' } })] : []),
  ];
  writeFileSync(join(dir, `${name}.jsonl`), `${rows.join('\n')}\n`, 'utf8');
}

describe('repoPathFromTranscripts', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'brain-repo-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('reads the real path from a transcript rather than the directory name', () => {
    // The encoded name is LOSSY: this one decodes naively to
    // /Users/dev/Repos/wombeats/ios, which does not exist. The real repo is
    // /Users/dev/Repos/wombeats-ios, and only the transcript knows that.
    const project = '-Users-dev-Repos-wombeats-ios';
    writeTranscript(tmp, project, 'sess-a', '/Users/dev/Repos/wombeats-ios');

    expect(repoPathFromTranscripts(join(tmp, 'projects', project)))
      .toBe('/Users/dev/Repos/wombeats-ios');
  });

  it('skips rows that carry no cwd', () => {
    writeTranscript(tmp, '-p', 'sess-a', '/Users/dev/repo');
    expect(repoPathFromTranscripts(join(tmp, 'projects', '-p'))).toBe('/Users/dev/repo');
  });

  it('returns null when no transcript carries a cwd', () => {
    writeTranscript(tmp, '-p', 'sess-a', null);
    expect(repoPathFromTranscripts(join(tmp, 'projects', '-p'))).toBeNull();
  });

  it('returns null for a directory with no transcripts', () => {
    mkdirSync(join(tmp, 'projects', '-empty'), { recursive: true });
    expect(repoPathFromTranscripts(join(tmp, 'projects', '-empty'))).toBeNull();
  });
});

describe('repo artifact source', () => {
  let tmp: string;
  let cfg: string;
  let repo: string;

  function accountsWith(resolved: number | null): AccountsService {
    return {
      listAccounts: () => [{ id: 1, config_dir: cfg }],
      resolve: () => ({
        claude: resolved === null ? null : { account: { id: resolved, config_dir: cfg } },
        codex: null,
      }),
    } as unknown as AccountsService;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brain-repoart-'));
    cfg = join(tmp, 'cfg');
    repo = join(tmp, 'repo');
    mkdirSync(repo, { recursive: true });
    writeTranscript(cfg, '-repo', 'sess-a', repo);
  });

  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('discovers CLAUDE.md and AGENTS.md, root and nested', async () => {
    writeFileSync(join(repo, 'CLAUDE.md'), '# rules\n\nsome rules\n', 'utf8');
    writeFileSync(join(repo, 'AGENTS.md'), '# agents\n\nagent rules\n', 'utf8');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'CLAUDE.md'), '# src rules\n\nnested\n', 'utf8');

    const items = await createRepoArtifactSource({ accounts: accountsWith(1) }).discover();
    expect(items.map((i) => i.itemKey).sort()).toEqual([
      `${repo}:AGENTS.md`,
      `${repo}:CLAUDE.md`,
      `${repo}:src/CLAUDE.md`,
    ]);
  });

  it('ignores README, CHANGELOG and docs', async () => {
    writeFileSync(join(repo, 'README.md'), '# readme\n', 'utf8');
    writeFileSync(join(repo, 'CHANGELOG.md'), '# changelog\n', 'utf8');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'design.md'), '# design\n', 'utf8');

    expect(await createRepoArtifactSource({ accounts: accountsWith(1) }).discover()).toEqual([]);
  });

  it('owns an artifact by resolve(), not by the config dir it was found through', async () => {
    writeFileSync(join(repo, 'CLAUDE.md'), '# rules\n\nsome rules\n', 'utf8');
    const items = await createRepoArtifactSource({ accounts: accountsWith(2) }).discover();
    expect(items[0].accountId).toBe(2);
  });

  it('omits an artifact whose repo resolves to no account', async () => {
    writeFileSync(join(repo, 'CLAUDE.md'), '# rules\n\nsome rules\n', 'utf8');
    // An adapter that cannot determine ownership omits the item rather than
    // guessing — guessing writes one account's material into another's vault.
    expect(await createRepoArtifactSource({ accounts: accountsWith(null) }).discover()).toEqual([]);
  });

  it('rejects an empty artifact', async () => {
    writeFileSync(join(repo, 'CLAUDE.md'), '   \n', 'utf8');
    const source = createRepoArtifactSource({ accounts: accountsWith(1) });
    const [item] = await source.discover();
    expect(source.admit(item).admitted).toBe(false);
  });

  it('distills the file with artifact metadata', async () => {
    writeFileSync(join(repo, 'CLAUDE.md'), '# rules\n\nuse npm, not yarn\n', 'utf8');
    const source = createRepoArtifactSource({ accounts: accountsWith(1) });
    const [item] = await source.discover();

    const distilled = await source.distill!(item);
    expect(distilled.prose).toContain('use npm, not yarn');
    expect(distilled.truncated).toBe(false);
    expect(distilled.metadata).toEqual({ kind: 'artifact', repoPath: repo, file: 'CLAUDE.md' });
  });

  it('truncates an oversized artifact and says so', async () => {
    writeFileSync(join(repo, 'CLAUDE.md'), `# rules\n\n${'x'.repeat(20_000)}\n`, 'utf8');
    const source = createRepoArtifactSource({ accounts: accountsWith(1) });
    const [item] = await source.discover();

    const distilled = await source.distill!(item);
    expect(distilled.truncated).toBe(true);
    expect(distilled.prose.length).toBeLessThan(20_000);
  });

  it('offers no translate — an artifact goes through the model', async () => {
    expect(createRepoArtifactSource({ accounts: accountsWith(1) }).translate).toBeUndefined();
  });
});
```

Append to `electron/__tests__/brain-extract.test.ts`, inside the existing
`describe('buildExtractionPrompt', …)`:

```ts
  const ARTIFACT: DistilledItem = {
    prose: '# CLAUDE.md\n\nPackage manager: npm. Tests live in electron/__tests__.',
    truncated: false,
    metadata: { kind: 'artifact', repoPath: '/Users/dev/Repos/omnifex', file: 'CLAUDE.md' },
  };

  it('describes a repo artifact as an instruction file, not a session', () => {
    const prompt = buildExtractionPrompt(ARTIFACT);
    expect(prompt).toContain('instruction file');
    expect(prompt).not.toContain('coding session');
    expect(prompt).not.toContain('turns:');
  });

  it('states the repo and file as facts', () => {
    const prompt = buildExtractionPrompt(ARTIFACT);
    expect(prompt).toContain('repository: /Users/dev/Repos/omnifex');
    expect(prompt).toContain('file: CLAUDE.md');
  });
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run electron/__tests__/brain-repo-artifact-source.test.ts electron/__tests__/brain-extract.test.ts`
Expected: FAIL — module not found, and the prompt has no `artifact` arm.

- [ ] **Step 3: Add the metadata arm and the prompt branch**

In `sources/types.ts`:

```ts
/**
 * Deterministic facts about a repo instruction file (`CLAUDE.md`/`AGENTS.md`).
 * There is no session and no capture behind one.
 */
export interface ArtifactMetadata {
  repoPath: string;
  /** Repo-relative, e.g. "CLAUDE.md" or "src/CLAUDE.md". */
  file: string;
}
```

and extend the union:

```ts
export type ItemMetadata =
  | ({ kind: 'session' } & SessionMetadata)
  | ({ kind: 'capture' } & CaptureMetadata)
  | ({ kind: 'artifact' } & ArtifactMetadata);
```

In `extract.ts`'s `buildExtractionPrompt`, extend the two existing ternaries
into switches on `m.kind`:

```ts
  const preamble =
    m.kind === 'capture'
      ? 'You are turning one fact a developer explicitly captured into durable vault entities.'
      : m.kind === 'artifact'
        ? "You are extracting durable engineering knowledge from a project's agent instruction file — the standing rules and architecture a developer wrote for this repository."
        : 'You are extracting durable engineering knowledge from one coding session.';

  const facts =
    m.kind === 'capture'
      ? [ /* unchanged */ ].join('\n')
      : m.kind === 'artifact'
        ? [`repository: ${m.repoPath}`, `file: ${m.file}`].join('\n')
        : [ /* unchanged session facts */ ].join('\n');
```

and the two remaining `m.kind === 'capture' ? … : …` spots (the empty-result
sentence and the `timelineEntry` sentence, plus the `TRANSCRIPT` heading) gain
an artifact arm: `'An instruction file that states nothing durable'`,
`'THIS file establishes'`, and heading `INSTRUCTION FILE`.

- [ ] **Step 4: Implement the adapter**

Create `electron/services/brain/sources/repo-artifacts.ts`:

```ts
/**
 * A repository's agent instruction files — `CLAUDE.md` and `AGENTS.md`.
 *
 * The file itself is already in the model's context in every session in that
 * repo, so storing it verbatim would add nothing. Extracting it seeds
 * `Projects/<repo>` and Subsystem notes that session-derived entities then
 * merge INTO, which is the actual argument for indexing artifacts at all.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AccountsService } from '../../accounts';
import type { AdmitVerdict, BrainSource, DistilledItem, SourceItem } from './types';

export const REPO_SOURCE_ID = 'repo';

const ARTIFACT_NAMES = new Set(['CLAUDE.md', 'AGENTS.md']);

/** Same ceiling the session distiller uses, for the same reason. */
const MAX_PROSE_BYTES = 8 * 1024;
const TRUNCATION_MARKER = '[… truncated to fit the size limit …]\n\n';

/** Directories never worth walking for instruction files. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.vite', 'build', 'coverage']);

/** How deep to walk for nested instruction files. Root plus three levels. */
const MAX_DEPTH = 3;

/** Bytes of a transcript read while looking for a `cwd`. */
const CWD_SCAN_BYTES = 256 * 1024;

function listDirSafe(path: string): { name: string; isDirectory: boolean }[] {
  try {
    return readdirSync(path, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    }));
  } catch {
    return [];
  }
}

/**
 * The repo path a project directory's transcripts actually ran in.
 *
 * NOT decoded from the directory name. The CLI's encoding replaces every
 * non-alphanumeric character with `-`, so `wombeats-ios` and `wombeats/ios`
 * encode identically and a naive decode produces a path that does not exist.
 * The transcript's own `cwd` is the only authority.
 */
export function repoPathFromTranscripts(
  projectDir: string,
  readChunk: (path: string) => string = (path) =>
    readFileSync(path, 'utf8').slice(0, CWD_SCAN_BYTES),
): string | null {
  for (const entry of listDirSafe(projectDir)) {
    if (entry.isDirectory || !entry.name.endsWith('.jsonl')) continue;
    let chunk: string;
    try {
      chunk = readChunk(join(projectDir, entry.name));
    } catch {
      continue;
    }
    for (const line of chunk.split('\n')) {
      if (!line.includes('"cwd"')) continue;
      try {
        const row = JSON.parse(line) as { cwd?: unknown };
        if (typeof row.cwd === 'string' && row.cwd) return row.cwd;
      } catch {
        // A truncated last line from the byte-bounded read. Keep looking.
      }
    }
  }
  return null;
}

function findArtifacts(root: string, dir: string, depth: number, out: string[]): void {
  for (const entry of listDirSafe(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory) {
      if (depth >= MAX_DEPTH || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      findArtifacts(root, full, depth + 1, out);
      continue;
    }
    if (ARTIFACT_NAMES.has(entry.name)) out.push(relative(root, full));
  }
}

export function createRepoArtifactSource(deps: { accounts: AccountsService }): BrainSource {
  /** `<repoPath>:<repo-relative file>` — unique, and readable in the tab. */
  function splitKey(itemKey: string): { repoPath: string; file: string } {
    const idx = itemKey.lastIndexOf(':');
    return { repoPath: itemKey.slice(0, idx), file: itemKey.slice(idx + 1) };
  }

  return {
    id: REPO_SOURCE_ID,

    discover(): Promise<SourceItem[]> {
      const items: SourceItem[] = [];
      const seenRepos = new Set<string>();

      for (const account of deps.accounts.listAccounts()) {
        const projectsDir = join(account.config_dir, 'projects');
        for (const project of listDirSafe(projectsDir)) {
          if (!project.isDirectory) continue;
          const repoPath = repoPathFromTranscripts(join(projectsDir, project.name));
          // No cwd in any transcript means no known path. Skipped, never guessed.
          if (!repoPath || seenRepos.has(repoPath)) continue;
          seenRepos.add(repoPath);

          // Ownership is resolve() on the repo, per spec §4 — NOT the config
          // dir this repo was found through. An unresolved repo is omitted:
          // an adapter that cannot determine ownership must not guess.
          const owner = deps.accounts.resolve(repoPath).claude?.account;
          if (!owner) continue;

          const files: string[] = [];
          findArtifacts(repoPath, repoPath, 0, files);
          for (const file of files) {
            const path = join(repoPath, file);
            let stat;
            try {
              stat = statSync(path);
            } catch {
              continue;
            }
            items.push({
              sourceId: REPO_SOURCE_ID,
              itemKey: `${repoPath}:${file}`,
              accountId: owner.id,
              path,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              label: file,
            });
          }
        }
      }
      return Promise.resolve(items);
    },

    admit(item: SourceItem): AdmitVerdict {
      let contents: string;
      try {
        contents = readFileSync(item.path, 'utf8');
      } catch {
        return { admitted: false, reason: 'instruction file could not be read' };
      }
      if (!contents.trim()) return { admitted: false, reason: 'instruction file is empty' };
      return { admitted: true, reason: 'agent instruction file' };
    },

    distill(item: SourceItem): Promise<DistilledItem> {
      const { repoPath, file } = splitKey(item.itemKey);
      const contents = readFileSync(item.path, 'utf8');
      const truncated = Buffer.byteLength(contents, 'utf8') > MAX_PROSE_BYTES;
      // Newest-first here, unlike a transcript: an instruction file's opening
      // sections state what the project IS, and dropping the tail loses detail
      // rather than context.
      const prose = truncated
        ? contents.slice(0, MAX_PROSE_BYTES) + `\n\n${TRUNCATION_MARKER}`
        : contents;
      return Promise.resolve({
        prose,
        truncated,
        metadata: { kind: 'artifact', repoPath, file },
      });
    },
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run electron/__tests__/brain-repo-artifact-source.test.ts electron/__tests__/brain-extract.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS. Fix any `ItemMetadata` exhaustiveness errors the third arm surfaces — `registry.ts`'s provenance date and `BrainSources.tsx`'s metadata table both switch on `kind`, and the artifact arm needs an entry in each (`date: today()` for artifacts, since a file has no event date; a `repository` / `file` row in the pane).

- [ ] **Step 6: Commit**

```bash
git add electron/services/brain/sources/repo-artifacts.ts electron/services/brain/sources/types.ts electron/services/brain/extract.ts electron/__tests__/brain-repo-artifact-source.test.ts electron/__tests__/brain-extract.test.ts electron/services/brain/registry.ts src/components/brain/BrainSources.tsx src/lib/api.ts
git commit -m "feat(brain): index repo CLAUDE.md and AGENTS.md into entity notes"
```

---

## Task 4: Wiring and the close-time trigger

**Files:**
- Modify: `electron/main.ts`
- Test: `electron/__tests__/brain-registry.test.ts` (backfill across all four sources)

**Interfaces:**
- Consumes: `createAutoMemorySource`, `createRepoArtifactSource`, existing `onSessionClosed`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `electron/__tests__/brain-registry.test.ts`:

```ts
it('backfills translating and extracting sources together', async () => {
  // Both kinds in one queue: the worker must not care which it claims.
  const brain = createBrainService(db, {
    execGit: stubExec,
    accounts: accountsStub,
    extractor: () => Promise.resolve({ entities: [] }),
    sources: [
      fakeTranslator(1, [{ relPath: 'Notes/x.md', note: NOTE }]),
      fakeExtractor(1, 'item-2'),
    ],
  });
  brain.setVaultPath(1, join(dir, 'both'));

  expect(await brain.backfill(1)).toBe(2);
  brain.closeAll();
});
```

with, beside `fakeTranslator`:

```ts
function fakeExtractor(accountId: number, itemKey: string): BrainSource {
  return {
    id: 'fake-extract',
    discover: () => Promise.resolve([{
      sourceId: 'fake-extract', itemKey, accountId,
      path: `/tmp/${itemKey}`, mtimeMs: 1, size: 10, label: 'fake',
    }]),
    admit: () => ({ admitted: true, reason: 'ok' }),
    distill: () => Promise.resolve({
      prose: 'x', truncated: false,
      metadata: { kind: 'capture', capturedAt: '2026-08-12T00:00:00.000Z', project: null, cwd: null },
    }),
  };
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run electron/__tests__/brain-registry.test.ts -t "backfills translating"`
Expected: FAIL — `fakeExtractor` is not defined.

- [ ] **Step 3: Make it pass**

Add the helper above. No production change is needed if Task 1 was done
correctly — this test exists to prove that, and if it fails for any other
reason, Task 1's branch is wrong.

- [ ] **Step 4: Wire both sources in `main.ts`**

Extend the `sources` array where `createBrainService` is constructed:

```ts
    sources: [
      createSessionSource({ accounts: accountsService }),
      captureSource,
      createAutoMemorySource({ accounts: accountsService }),
      createRepoArtifactSource({ accounts: accountsService }),
    ],
```

with the two imports beside the existing source imports.

- [ ] **Step 5: Extend the close-time enqueue**

In `main.ts`'s `onSessionClosed`, inside the existing
`if (db.getSetting(BRAIN_AUTO_INDEX_SETTING_KEY) === 'true')` block, after the
transcript enqueue, add the project's other sources:

```ts
          // The session just closed in this project, which is exactly when its
          // auto-memory and instruction files were most likely edited. Change
          // detection makes the ordinary case a free no-op.
          //
          // Enqueued by discovery rather than by constructing keys here: the
          // key formats belong to the adapters, and duplicating them in main
          // would be two spellings to keep in step.
          brainService
            ?.enqueueProjectSources(account.id, projectPath)
            .catch((err: unknown) => console.warn('[main] brain project enqueue failed:', err));
```

and add that one method to `BrainService` in `registry.ts`:

```ts
  /**
   * Queue every non-session item this account owns that belongs to `projectPath`
   * — its auto-memory notes and its repo instruction files. Returns how many
   * were queued.
   *
   * Matched on the item's own path rather than on a reconstructed key, so an
   * adapter can change its key format without this going quietly stale.
   */
  enqueueProjectSources(accountId: number, projectPath: string): Promise<number>;
```

implemented as:

```ts
    async enqueueProjectSources(accountId: number, projectPath: string): Promise<number> {
      requireAccountId(accountId);
      const encoded = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
      let queued = 0;
      for (const source of sources) {
        if (source.id === SESSION_SOURCE_ID) continue; // Already enqueued by key.
        for (const item of await source.discover()) {
          if (item.accountId !== accountId) continue;
          // An auto-memory item's key is `<encoded project>/<file>`; a repo
          // artifact's is `<repoPath>:<file>`. Matching either shape here keeps
          // the check to one line without teaching main.ts the formats.
          const belongs =
            item.itemKey.startsWith(`${encoded}/`) || item.itemKey.startsWith(`${projectPath}:`);
          if (!belongs) continue;
          if (!source.admit(item).admitted) continue;
          const prior = sourceState.get(accountId, item.sourceId, item.itemKey);
          if (prior?.status === 'indexed' && !sourceState.hasChanged(item)) continue;
          queueStore.enqueue(accountId, item.sourceId, item.itemKey);
          queued += 1;
        }
      }
      return queued;
    },
```

Import `SESSION_SOURCE_ID` from `./sources/session-transcripts`.

Add `'brain_enqueue_project_sources'` to `electron/ipc/channels.ts`, a handler
in `brain-handlers.ts` mirroring `brain_backfill`'s write-path shape (throw
when `brain` is undefined), and the matching method in `src/lib/api.ts`. Add
the channel name to `CHANNELS` in `electron/__tests__/brain-ipc.test.ts`.

- [ ] **Step 6: Run everything**

Run: `npx vitest run electron/`
Expected: PASS.

Run: `npm run check && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(brain): index a project's memory and instruction files on session close"
```

---

## Task 5: Verification and live proof

**Files:**
- Modify: `docs/superpowers/plans/2026-08-11-brain-vault-followups.md`

- [ ] **Step 1: Run the gate**

```bash
npm run check
npm run build
npm run test:coverage
```

Expected: all pass. Record the `electron/services/brain` coverage number.

- [ ] **Step 2: Prove auto-memory translation on the real corpus — free**

Translation spends nothing, so run it over all 102 real files into a throwaway
vault. Write `/tmp/automem-e2e.ts` importing with ABSOLUTE paths (a script
outside the repo cannot resolve `./electron/...`), wrap the body in an
`async function main()` (tsx compiles to CJS, so no top-level await), and
insert an `accounts` row before indexing (`brain_sources` has an FK to it):

```ts
import { createDatabase } from '/Users/gregorychristie/Repos/personal/omnifex/electron/services/database';
import { createBrainService } from '/Users/gregorychristie/Repos/personal/omnifex/electron/services/brain/registry';
import { createAutoMemorySource } from '/Users/gregorychristie/Repos/personal/omnifex/electron/services/brain/sources/auto-memory';

async function main() {
  const VAULT = '/tmp/brain-automem-e2e/vault';
  require('node:fs').rmSync('/tmp/brain-automem-e2e', { recursive: true, force: true });
  require('node:fs').mkdirSync(VAULT, { recursive: true });

  const db = createDatabase(':memory:');
  db.raw.prepare('INSERT INTO accounts (id, name, config_dir) VALUES (?, ?, ?)')
    .run(1, 'Personal', `${process.env.HOME}/.claude-personal`);
  const accounts = {
    listAccounts: () => [{ id: 1, config_dir: `${process.env.HOME}/.claude-personal` }],
  } as never;

  const brain = createBrainService(db, {
    accounts,
    sources: [createAutoMemorySource({ accounts })],
  });
  brain.setVaultPath(1, VAULT);
  brain.open(1);

  const items = await brain.listSources(1);
  console.log('discovered:', items.length, 'admitted:', items.filter((i) => i.admitted).length);

  let written = 0;
  for (const item of items.filter((i) => i.admitted)) {
    const r = await brain.indexSource(1, item.itemKey);
    written += r.notesWritten.length;
  }
  console.log('notes written:', written);

  // Idempotency on real output, with no model involved at all.
  const second = await brain.indexSource(1, items[0].itemKey);
  console.log('second run skipped:', second.skipped, second.reason);

  console.log('search "node-pty":', brain.search(1, 'node-pty').map((h) => h.notePath).slice(0, 3));
  brain.closeAll();
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Run: `npm rebuild better-sqlite3 && npx tsx /tmp/automem-e2e.ts`

Expected: ~93 discovered, all admitted, ~93 notes written, the second run
skipped as unchanged, and a `node-pty` search returning the translated note.
**Then spot-check one note on disk** and confirm its `[[wikilinks]]` survived
and its body is verbatim.

- [ ] **Step 3: Prove repo-artifact extraction on one real file**

Extend the same script to add `createRepoArtifactSource` and `createExtractor()`,
then index exactly ONE artifact (this repo's own `CLAUDE.md`) so the spend is a
single Sonnet call. Confirm the entity notes it produces name real subsystems.

- [ ] **Step 4: Rebuild for Electron**

```bash
npm run rebuild:electron
```

Expected: `verified: native modules at NMV 145 (Electron ABI)`.

- [ ] **Step 5: Record findings**

Append an "Opened by Plan 6" section to
`docs/superpowers/plans/2026-08-11-brain-vault-followups.md`: the measured
counts, anything the translation got wrong on the real corpus, and whether the
artifact extraction produced entities worth having.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: record Plan 6's verification"
```

---

## Notes (fill in during execution)

- **Auto-memory:** 86 discovered / 83 admitted / 83 notes written, in 99ms with
  no model. Three rejects, all genuinely frontmatter-less hand-written files.
- **Did wikilinks survive?** Yes, and better after a fix: 83% of targets bound,
  rising to 90% once `linkMatchesNote` was made separator-insensitive to match
  `resolve.ts`'s `fold()`. Backlinks verified working across translated notes.
- **Was the artifact extraction worth its token?** Yes, with a caveat. This
  repo's `CLAUDE.md` produced a `Projects/OmniFex.md` whose every factual claim
  checks out — but only ONE entity, not the Subsystem seeds the spec predicted,
  and the model left `"...wait"` and `"placeholder"` in `keyFacts`.
- **Coverage:** `electron/services/brain` 94.88% statements / 96.23% lines;
  `electron/services` 88.87% / 91.01%. Above the 80%-lines backend target.
- **The design was wrong about `name:`.** 72 of 90 real files have a `name`
  that differs from the filename, and some contain `/`. Notes are named after
  the source file; see the followups doc.
