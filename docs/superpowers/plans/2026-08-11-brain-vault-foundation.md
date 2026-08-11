# Brain Vault Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the per-account Markdown vault, its git versioning, and its FTS5 search index — with no LLM anywhere — so every layer above it can be built against something already verifiable.

**Architecture:** Each Claude account owns a self-contained vault directory holding Markdown notes, a git repo, and its own SQLite FTS5 index at `<vault>/.omnifex/index.db`. A registry in the main process maps `accountId → vault handle`; nothing can operate on "the vault" without naming an account first. Orchestration state (`brain_sources`, `brain_queue`) lives in `greychrist.db` keyed by `account_id`; note *content* never does.

**Tech Stack:** TypeScript, Electron main process, `better-sqlite3` (FTS5), `js-yaml`, `zod`, system `git` via `execFile`, Vitest.

**Plan 1 of 7.** Covers step 1 of the spec's build sequence. Later plans: Brain tab (2), session adapter (3), extract/merge/queue (4), MCP server + `/recall` + capture adapter (5), repo & auto-memory adapters (6), curation (7).

**Spec:** `docs/superpowers/specs/2026-08-11-brain-memory-vault-design.md`

## Global Constraints

- **Per-account isolation is the top invariant.** A source owned by account A never produces a write outside A's vault, and a search against A's vault never returns a note from B's. Isolation is structural — separate database files — never a `WHERE` clause.
- **No shared note-content table.** There is no `account_id` column on `brain_fts`, because there is no shared FTS table.
- **Every Brain IPC channel takes an explicit `accountId`.** No implicit current-account default.
- **No silent default-account fallback.** Unresolved account means the operation does not happen and records why.
- **Never write into a Claude config dir**, and never resolve a user path from a hardcoded `~/.claude/` — always from the account's `config_dir`.
- **The Brain is auxiliary.** No Brain failure may break a session, block the UI, or throw out of a service constructor.
- The vault's index DB is derived and disposable; the Markdown files are the source of truth.
- FTS5 tokenizer is exactly: `porter unicode61 tokenchars '-_'`.
- Services are factory functions (`createX(deps) -> X`), matching `electron/services/branch-colors.ts:24`.
- Tests live in `electron/__tests__/*.test.ts` and use `createDatabase(':memory:')` for DB-backed work.
- Run `npm run rebuild:electron` after any vitest run, before launching the app.

---

### Task 1: Frontmatter parse and serialize

Notes are YAML frontmatter plus a Markdown body. This is the lowest layer — everything else reads and writes through it. It gets a real YAML parser rather than a regex, which is the specific bug class the spec chose YAML to avoid.

**Files:**
- Modify: `package.json` (add `js-yaml`, `@types/js-yaml`)
- Create: `electron/services/brain/types.ts`
- Create: `electron/services/brain/frontmatter.ts`
- Test: `electron/__tests__/brain-frontmatter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `NoteType`, `NoteFrontmatter`, `ParsedNote`, `NoteParseError`, `parseNote(raw: string): ParsedNote`, `serializeNote(note: ParsedNote): string`.

- [ ] **Step 1: Install the YAML parser**

`js-yaml` is currently only a transitive dev dependency of eslint, so it cannot be imported safely. Declare it.

```bash
npm install js-yaml@^4.1.0
npm install --save-dev @types/js-yaml@^4.0.9
```

- [ ] **Step 2: Write the failing test**

Create `electron/__tests__/brain-frontmatter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseNote, serializeNote, NoteParseError } from '../services/brain/frontmatter';

const SAMPLE = `---
type: Subsystem
project: "[[Projects/omnifex]]"
aliases: [permission decider, permission-prompt-tool]
keywords: [permissions, stdio]
created: 2026-05-31
updated: 2026-08-08
sources: [session:abc123]
---
# Permission decider

## Summary
Enforces mid-session permission changes.
`;

describe('parseNote', () => {
  it('parses frontmatter fields', () => {
    const note = parseNote(SAMPLE);
    expect(note.frontmatter.type).toBe('Subsystem');
    expect(note.frontmatter.aliases).toEqual(['permission decider', 'permission-prompt-tool']);
    expect(note.frontmatter.keywords).toEqual(['permissions', 'stdio']);
    expect(note.frontmatter.sources).toEqual(['session:abc123']);
    expect(note.frontmatter.project).toBe('[[Projects/omnifex]]');
  });

  it('keeps the body verbatim, without the fence', () => {
    const note = parseNote(SAMPLE);
    expect(note.body.startsWith('# Permission decider')).toBe(true);
    expect(note.body).not.toContain('---');
  });

  it('defaults missing list fields to empty arrays', () => {
    const note = parseNote('---\ntype: Topic\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# T\n');
    expect(note.frontmatter.aliases).toEqual([]);
    expect(note.frontmatter.keywords).toEqual([]);
    expect(note.frontmatter.sources).toEqual([]);
  });

  it('does not bleed the next line into an empty field', () => {
    // The exact bug Rowboat's regex-based extractField had to be patched for.
    const note = parseNote('---\ntype: Topic\nproject:\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# T\n');
    expect(note.frontmatter.project).toBeUndefined();
  });

  it('throws NoteParseError when the fence is missing', () => {
    expect(() => parseNote('# Just a heading\n')).toThrow(NoteParseError);
  });

  it('throws NoteParseError on malformed YAML', () => {
    expect(() => parseNote('---\ntype: [unclosed\n---\n# T\n')).toThrow(NoteParseError);
  });

  it('throws NoteParseError on an unknown note type', () => {
    expect(() => parseNote('---\ntype: Alien\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# T\n'))
      .toThrow(NoteParseError);
  });
});

describe('serializeNote', () => {
  it('round-trips: parse then serialize then parse is stable', () => {
    const once = serializeNote(parseNote(SAMPLE));
    const twice = serializeNote(parseNote(once));
    expect(twice).toBe(once);
  });

  it('omits undefined optional fields entirely', () => {
    const out = serializeNote({
      frontmatter: {
        type: 'Topic', aliases: [], keywords: [], sources: [],
        created: '2026-01-01', updated: '2026-01-01',
      },
      body: '# T\n',
    });
    expect(out).not.toContain('project:');
    expect(out).not.toContain('curated_at:');
  });

  it('emits a parseable fence', () => {
    const out = serializeNote({
      frontmatter: {
        type: 'Project', aliases: ['a'], keywords: [], sources: [],
        created: '2026-01-01', updated: '2026-01-01',
      },
      body: '# P\n',
    });
    expect(parseNote(out).frontmatter.aliases).toEqual(['a']);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/brain-frontmatter.test.ts`
Expected: FAIL — cannot resolve `../services/brain/frontmatter`.

- [ ] **Step 4: Write the shared types**

Create `electron/services/brain/types.ts`:

```ts
/** Entity and record folders in a vault. Mirrors config/notes.json. */
export const NOTE_TYPES = ['Project', 'Subsystem', 'Topic', 'Session', 'Note'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

/** Folder each note type lives in, relative to the vault root. */
export const NOTE_FOLDERS: Record<NoteType, string> = {
  Project: 'Projects',
  Subsystem: 'Subsystems',
  Topic: 'Topics',
  Session: 'Sessions',
  Note: 'Notes',
};

export interface NoteFrontmatter {
  type: NoteType;
  /** Wikilink to the owning project, e.g. "[[Projects/omnifex]]". */
  project?: string;
  aliases: string[];
  keywords: string[];
  /** ISO date (YYYY-MM-DD). */
  created: string;
  updated: string;
  curated_at?: string;
  /** Provenance keys, e.g. "session:abc123". Drives merge dedup. */
  sources: string[];
}

export interface ParsedNote {
  frontmatter: NoteFrontmatter;
  body: string;
}
```

- [ ] **Step 5: Write the frontmatter module**

Create `electron/services/brain/frontmatter.ts`:

```ts
import { load, dump } from 'js-yaml';
import { z } from 'zod';
import { NOTE_TYPES, type NoteFrontmatter, type ParsedNote } from './types';

/**
 * Thrown when a note cannot be read. Callers isolate the failure to the single
 * note rather than failing a whole scan — a hand-edited file must never take
 * the vault down.
 */
export class NoteParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteParseError';
  }
}

const FrontmatterSchema = z.object({
  type: z.enum(NOTE_TYPES),
  project: z.string().optional(),
  aliases: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  created: z.string(),
  updated: z.string(),
  curated_at: z.string().optional(),
  sources: z.array(z.string()).default([]),
});

/** Matches a leading `---` fence and captures the YAML plus the remaining body. */
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseNote(raw: string): ParsedNote {
  const match = FENCE.exec(raw);
  if (!match) {
    throw new NoteParseError('note has no YAML frontmatter fence');
  }

  let loaded: unknown;
  try {
    loaded = load(match[1]) ?? {};
  } catch (err) {
    throw new NoteParseError(`invalid YAML frontmatter: ${(err as Error).message}`);
  }

  // `project:` with no value parses as null; treat that as absent rather than
  // letting a null reach the schema.
  if (loaded && typeof loaded === 'object') {
    for (const [k, v] of Object.entries(loaded as Record<string, unknown>)) {
      if (v === null) delete (loaded as Record<string, unknown>)[k];
    }
  }

  const result = FrontmatterSchema.safeParse(loaded);
  if (!result.success) {
    throw new NoteParseError(`invalid frontmatter: ${result.error.issues[0]?.message ?? 'unknown'}`);
  }

  return { frontmatter: result.data, body: match[2] };
}

export function serializeNote(note: ParsedNote): string {
  const fm: Record<string, unknown> = {
    type: note.frontmatter.type,
  };
  if (note.frontmatter.project !== undefined) fm.project = note.frontmatter.project;
  fm.aliases = note.frontmatter.aliases;
  fm.keywords = note.frontmatter.keywords;
  fm.created = note.frontmatter.created;
  fm.updated = note.frontmatter.updated;
  if (note.frontmatter.curated_at !== undefined) fm.curated_at = note.frontmatter.curated_at;
  fm.sources = note.frontmatter.sources;

  // flowLevel: 1 keeps arrays on one line ([a, b]) so notes stay readable in
  // Obsidian. lineWidth: -1 disables wrapping, which would otherwise reflow
  // long alias lists differently on each write and break byte-identical
  // idempotency.
  const yaml = dump(fm, { flowLevel: 1, lineWidth: -1, quotingType: '"' });
  return `---\n${yaml}---\n${note.body}`;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run electron/__tests__/brain-frontmatter.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json electron/services/brain/types.ts electron/services/brain/frontmatter.ts electron/__tests__/brain-frontmatter.test.ts
git commit -m "feat(brain): note frontmatter parse and serialize"
```

---

### Task 2: FTS5 query sanitizer

FTS5 `MATCH` takes an expression language, not a string. Raw input containing `-`, `"`, `*`, or a bare `OR` either raises `SQLITE_ERROR` or silently means something the user didn't ask for. This pure function is the single highest-risk piece of the search path, so it is isolated and tested on its own.

**Files:**
- Create: `electron/services/brain/fts-query.ts`
- Test: `electron/__tests__/brain-fts-query.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `toFtsQuery(input: string): string | null` — returns `null` when the input yields no searchable tokens, meaning the caller should return zero results without touching SQLite.

- [ ] **Step 1: Write the failing test**

Create `electron/__tests__/brain-fts-query.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toFtsQuery } from '../services/brain/fts-query';

describe('toFtsQuery', () => {
  it('returns null for empty or whitespace input', () => {
    expect(toFtsQuery('')).toBeNull();
    expect(toFtsQuery('   ')).toBeNull();
  });

  it('returns null when no token survives', () => {
    expect(toFtsQuery('***')).toBeNull();
    expect(toFtsQuery('!!! ???')).toBeNull();
  });

  it('keeps hyphenated identifiers as one token', () => {
    expect(toFtsQuery('node-pty')).toBe('"node-pty"');
  });

  it('keeps underscored identifiers as one token', () => {
    expect(toFtsQuery('can_use_tool')).toBe('"can_use_tool"');
  });

  it('ANDs multiple terms', () => {
    expect(toFtsQuery('permission decider')).toBe('"permission" AND "decider"');
  });

  it('drops FTS5 operator keywords so they are not searched literally', () => {
    expect(toFtsQuery('foo OR bar')).toBe('"foo" AND "bar"');
    expect(toFtsQuery('foo NOT bar')).toBe('"foo" AND "bar"');
    expect(toFtsQuery('foo NEAR bar')).toBe('"foo" AND "bar"');
  });

  it('treats lowercase operator words as ordinary terms', () => {
    expect(toFtsQuery('this or that')).toBe('"this" AND "or" AND "that"');
  });

  it('neutralises embedded double quotes', () => {
    expect(toFtsQuery('say "hi"')).toBe('"say" AND "hi"');
  });

  it('strips wildcards and punctuation rather than passing them through', () => {
    expect(toFtsQuery('perm* (stdio)')).toBe('"perm" AND "stdio"');
  });

  it('preserves unicode letters and digits', () => {
    expect(toFtsQuery('café v2')).toBe('"café" AND "v2"');
  });

  it('returns null when the input is only operator keywords', () => {
    expect(toFtsQuery('AND OR NOT')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/brain-fts-query.test.ts`
Expected: FAIL — cannot resolve `../services/brain/fts-query`.

- [ ] **Step 3: Write the implementation**

Create `electron/services/brain/fts-query.ts`:

```ts
/**
 * FTS5 treats bare AND / OR / NOT / NEAR as operators. They are uppercase-only
 * in the FTS5 grammar, so dropping the uppercase forms leaves ordinary
 * lowercase words ("this or that") searchable as terms.
 */
const FTS_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

/**
 * Token characters must match the table's `tokenchars '-_'` setting, so that
 * `node-pty` is one query token exactly as it is one indexed token.
 */
const TOKEN = /[\p{L}\p{N}_-]+/gu;

/**
 * Convert free user input into a safe FTS5 MATCH expression.
 *
 * Every token is emitted as a quoted string literal, so no input can inject
 * operators, wildcards, or unbalanced quotes. Returns null when nothing
 * searchable remains — callers must return zero results rather than running a
 * query with an empty MATCH, which is a syntax error.
 */
export function toFtsQuery(input: string): string | null {
  const tokens = (input.match(TOKEN) ?? []).filter((t) => !FTS_KEYWORDS.has(t));
  if (tokens.length === 0) return null;
  // FTS5 escapes a double quote inside a string literal by doubling it. The
  // tokenizer above cannot emit one, but the escape is kept so this stays
  // correct if TOKEN ever widens.
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/__tests__/brain-fts-query.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/services/brain/fts-query.ts electron/__tests__/brain-fts-query.test.ts
git commit -m "feat(brain): FTS5 query sanitizer"
```

---

### Task 3: Vault layout and note I/O

The vault directory: creating its structure, mapping a note type and name to a path, and reading and writing notes. Path construction is security-relevant — a note name derived from model output must never escape the vault.

**Files:**
- Create: `electron/services/brain/vault.ts`
- Test: `electron/__tests__/brain-vault.test.ts`

**Interfaces:**
- Consumes: `parseNote`, `serializeNote`, `NoteParseError` (Task 1); `NoteType`, `NOTE_FOLDERS`, `ParsedNote` (Task 1).
- Produces: `Vault` with `root: string`, `ensureLayout(): void`, `notePath(type: NoteType, name: string): string`, `readNote(relPath): ParsedNote`, `writeNote(relPath, note): void`, `listNotes(): string[]`, `noteTitle(relPath): string`; `createVault(root: string): Vault`; `VaultPathError`.

- [ ] **Step 1: Write the failing test**

Create `electron/__tests__/brain-vault.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault, VaultPathError, type Vault } from '../services/brain/vault';
import { NoteParseError } from '../services/brain/frontmatter';
import type { ParsedNote } from '../services/brain/types';

const NOTE: ParsedNote = {
  frontmatter: {
    type: 'Subsystem', aliases: ['decider'], keywords: ['permissions'],
    created: '2026-01-01', updated: '2026-01-01', sources: [],
  },
  body: '# Permission decider\n\n## Summary\nEnforces permission changes.\n',
};

describe('vault', () => {
  let dir: string;
  let vault: Vault;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnifex-vault-'));
    vault = createVault(dir);
    vault.ensureLayout();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates every note folder', () => {
    for (const f of ['Projects', 'Subsystems', 'Topics', 'Sessions', 'Notes', 'config']) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
  });

  it('writes a .gitignore that excludes the derived index', () => {
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.omnifex/');
  });

  it('seeds config/notes.json with the note type definitions', () => {
    const defs = JSON.parse(readFileSync(join(dir, 'config', 'notes.json'), 'utf8'));
    expect(defs.map((d: { type: string }) => d.type)).toContain('Subsystem');
  });

  it('does not clobber an edited config/notes.json', () => {
    writeFileSync(join(dir, 'config', 'notes.json'), '[{"type":"Topic","folder":"Topics","template":"x","extractionGuide":"y"}]');
    vault.ensureLayout();
    const defs = JSON.parse(readFileSync(join(dir, 'config', 'notes.json'), 'utf8'));
    expect(defs).toHaveLength(1);
  });

  it('maps a type and name to a path inside the right folder', () => {
    expect(vault.notePath('Subsystem', 'Permission decider')).toBe('Subsystems/Permission decider.md');
  });

  it('rejects names containing path separators', () => {
    expect(() => vault.notePath('Topic', 'a/b')).toThrow(VaultPathError);
    expect(() => vault.notePath('Topic', 'a\\b')).toThrow(VaultPathError);
  });

  it('rejects traversal attempts', () => {
    expect(() => vault.notePath('Topic', '..')).toThrow(VaultPathError);
    expect(() => vault.notePath('Topic', '../../etc/passwd')).toThrow(VaultPathError);
  });

  it('rejects empty names', () => {
    expect(() => vault.notePath('Topic', '   ')).toThrow(VaultPathError);
  });

  it('round-trips a note through write and read', () => {
    const rel = vault.notePath('Subsystem', 'Permission decider');
    vault.writeNote(rel, NOTE);
    const read = vault.readNote(rel);
    expect(read.frontmatter.aliases).toEqual(['decider']);
    expect(read.body).toBe(NOTE.body);
  });

  it('lists notes relative to the root, excluding .git and .omnifex', () => {
    vault.writeNote(vault.notePath('Subsystem', 'A'), NOTE);
    vault.writeNote(vault.notePath('Topic', 'B'), { ...NOTE, frontmatter: { ...NOTE.frontmatter, type: 'Topic' } });
    mkdirSync(join(dir, '.omnifex'), { recursive: true });
    writeFileSync(join(dir, '.omnifex', 'stray.md'), 'x');
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'COMMIT_EDITMSG.md'), 'x');

    expect(vault.listNotes().sort()).toEqual(['Subsystems/A.md', 'Topics/B.md']);
  });

  it('derives a title from the filename', () => {
    expect(vault.noteTitle('Subsystems/Permission decider.md')).toBe('Permission decider');
  });

  it('surfaces NoteParseError for a corrupt note without affecting others', () => {
    vault.writeNote(vault.notePath('Subsystem', 'Good'), NOTE);
    writeFileSync(join(dir, 'Topics', 'Bad.md'), 'no frontmatter here\n');
    expect(() => vault.readNote('Topics/Bad.md')).toThrow(NoteParseError);
    expect(vault.readNote('Subsystems/Good.md').frontmatter.type).toBe('Subsystem');
  });

  it('rejects reads that escape the vault root', () => {
    expect(() => vault.readNote('../outside.md')).toThrow(VaultPathError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/brain-vault.test.ts`
Expected: FAIL — cannot resolve `../services/brain/vault`.

- [ ] **Step 3: Write the implementation**

Create `electron/services/brain/vault.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, relative, resolve, sep } from 'node:path';
import { parseNote, serializeNote } from './frontmatter';
import { NOTE_FOLDERS, type NoteType, type ParsedNote } from './types';

/** Thrown when a note name or relative path would escape the vault root. */
export class VaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultPathError';
  }
}

/** Directories never scanned for notes. */
const EXCLUDED_DIRS = new Set(['.git', '.omnifex']);

/**
 * Seed note-type definitions written to config/notes.json on first use. Kept
 * config-driven (Rowboat's note_system.ts pattern) so adding a type is an edit
 * rather than a code change, and so the template and the extraction prompt
 * render from one source and cannot drift.
 */
const DEFAULT_NOTE_DEFS = [
  {
    type: 'Project',
    folder: 'Projects',
    template: '# {Name}\n\n## Summary\n\n## Subsystems\n\n## Topics\n\n## Timeline\n\n## Decisions\n\n## Key facts\n\n## Open items\n\n## Assistant notes\n',
    extractionGuide: 'Look for: repo purpose, stack, conventions, status.',
  },
  {
    type: 'Subsystem',
    folder: 'Subsystems',
    template: '# {Name}\n\n## Summary\n\n## Connected to\n\n## Timeline\n\n## Decisions\n\n## Key facts\n\n## Open items\n\n## Assistant notes\n',
    extractionGuide: 'Look for: component name, responsibility, owning project, constraints.',
  },
  {
    type: 'Topic',
    folder: 'Topics',
    template: '# {Name}\n\n## Summary\n\n## Related\n\n## Timeline\n\n## Decisions\n\n## Key facts\n\n## Open items\n\n## Assistant notes\n',
    extractionGuide: 'Look for: cross-cutting concern, keywords, related projects.',
  },
  { type: 'Session', folder: 'Sessions', template: '', extractionGuide: 'Session digest record.' },
  { type: 'Note', folder: 'Notes', template: '', extractionGuide: 'Explicit capture or ingested memory.' },
];

const GITIGNORE = '# Derived search index — rebuildable from the Markdown.\n.omnifex/\n';

export interface Vault {
  readonly root: string;
  ensureLayout(): void;
  notePath(type: NoteType, name: string): string;
  readNote(relPath: string): ParsedNote;
  writeNote(relPath: string, note: ParsedNote): void;
  listNotes(): string[];
  noteTitle(relPath: string): string;
}

export function createVault(root: string): Vault {
  const absoluteRoot = resolve(root);

  /** Resolve a vault-relative path, refusing anything that escapes the root. */
  function safeJoin(relPath: string): string {
    const abs = resolve(absoluteRoot, relPath);
    if (abs !== absoluteRoot && !abs.startsWith(absoluteRoot + sep)) {
      throw new VaultPathError(`path escapes the vault root: ${relPath}`);
    }
    return abs;
  }

  return {
    root: absoluteRoot,

    ensureLayout(): void {
      mkdirSync(absoluteRoot, { recursive: true });
      for (const folder of Object.values(NOTE_FOLDERS)) {
        mkdirSync(join(absoluteRoot, folder), { recursive: true });
      }
      mkdirSync(join(absoluteRoot, 'config'), { recursive: true });

      const gitignore = join(absoluteRoot, '.gitignore');
      if (!existsSync(gitignore)) writeFileSync(gitignore, GITIGNORE, 'utf8');

      const defs = join(absoluteRoot, 'config', 'notes.json');
      if (!existsSync(defs)) {
        writeFileSync(defs, JSON.stringify(DEFAULT_NOTE_DEFS, null, 2) + '\n', 'utf8');
      }
    },

    notePath(type: NoteType, name: string): string {
      const trimmed = name.trim();
      if (!trimmed) throw new VaultPathError('note name is empty');
      if (trimmed.includes('/') || trimmed.includes('\\')) {
        throw new VaultPathError(`note name contains a path separator: ${name}`);
      }
      if (trimmed === '.' || trimmed === '..') {
        throw new VaultPathError(`note name is a directory reference: ${name}`);
      }
      return `${NOTE_FOLDERS[type]}/${trimmed}.md`;
    },

    readNote(relPath: string): ParsedNote {
      return parseNote(readFileSync(safeJoin(relPath), 'utf8'));
    },

    writeNote(relPath: string, note: ParsedNote): void {
      const abs = safeJoin(relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, serializeNote(note), 'utf8');
    },

    listNotes(): string[] {
      const out: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          if (EXCLUDED_DIRS.has(entry)) continue;
          const abs = join(dir, entry);
          if (statSync(abs).isDirectory()) walk(abs);
          else if (entry.endsWith('.md')) out.push(relative(absoluteRoot, abs).split(sep).join('/'));
        }
      };
      if (existsSync(absoluteRoot)) walk(absoluteRoot);
      return out;
    },

    noteTitle(relPath: string): string {
      return basename(relPath, '.md');
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/__tests__/brain-vault.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/services/brain/vault.ts electron/__tests__/brain-vault.test.ts
git commit -m "feat(brain): vault layout and note I/O"
```

---

### Task 4: Vault git versioning

Every write path commits. This is what makes the later curation pass safe — a bad rewrite is one `git revert` away. Commits are serialized through a promise mutex so concurrent writers cannot interleave, and a missing `git` binary degrades to versioning-disabled rather than failing the write.

**Files:**
- Create: `electron/services/brain/git.ts`
- Test: `electron/__tests__/brain-git.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ExecGit = (args: string[], cwd: string) => Promise<void>`; `VaultGit` with `available(): Promise<boolean>`, `init(): Promise<void>`, `commitAll(message: string): Promise<boolean>`; `createVaultGit(root: string, exec?: ExecGit): VaultGit`. `commitAll` resolves `true` when a commit was made, `false` when versioning is unavailable or there was nothing to commit.

- [ ] **Step 1: Write the failing test**

Create `electron/__tests__/brain-git.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createVaultGit, type ExecGit } from '../services/brain/git';

describe('vault git', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnifex-git-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports available when git runs', async () => {
    expect(await createVaultGit(dir).available()).toBe(true);
  });

  it('reports unavailable when git cannot be spawned', async () => {
    const failing: ExecGit = async () => { throw new Error('ENOENT'); };
    expect(await createVaultGit(dir, failing).available()).toBe(false);
  });

  it('init creates a repo', async () => {
    await createVaultGit(dir).init();
    expect(existsSync(join(dir, '.git'))).toBe(true);
  });

  it('init is idempotent', async () => {
    const git = createVaultGit(dir);
    await git.init();
    await git.init();
    expect(existsSync(join(dir, '.git'))).toBe(true);
  });

  it('commitAll commits new files and returns true', async () => {
    const git = createVaultGit(dir);
    await git.init();
    writeFileSync(join(dir, 'a.md'), 'hello');
    expect(await git.commitAll('Index session abc')).toBe(true);

    const log = execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' });
    expect(log.trim()).toBe('Index session abc');
  });

  it('commitAll returns false when there is nothing to commit', async () => {
    const git = createVaultGit(dir);
    await git.init();
    writeFileSync(join(dir, 'a.md'), 'hello');
    await git.commitAll('first');
    expect(await git.commitAll('second')).toBe(false);
  });

  it('commitAll returns false rather than throwing when git is unavailable', async () => {
    const failing: ExecGit = async () => { throw new Error('ENOENT'); };
    expect(await createVaultGit(dir, failing).commitAll('x')).toBe(false);
  });

  it('serialises concurrent commits through the mutex', async () => {
    const order: string[] = [];
    const slow: ExecGit = async (args) => {
      if (args[0] === 'commit') {
        order.push(`start:${args[args.length - 1]}`);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`end:${args[args.length - 1]}`);
      }
    };
    const git = createVaultGit(dir, slow);
    await Promise.all([git.commitAll('A'), git.commitAll('B')]);

    // No interleaving: each commit's start is immediately followed by its end.
    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/brain-git.test.ts`
Expected: FAIL — cannot resolve `../services/brain/git`.

- [ ] **Step 3: Write the implementation**

Create `electron/services/brain/git.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Injectable git runner. Matches the pattern in git-branches.ts / git-worktrees.ts. */
export type ExecGit = (args: string[], cwd: string) => Promise<void>;

const defaultExec: ExecGit = async (args, cwd) => {
  await execFileAsync('git', args, { cwd });
};

export interface VaultGit {
  available(): Promise<boolean>;
  init(): Promise<void>;
  /** Returns true when a commit was created, false when unavailable or a no-op. */
  commitAll(message: string): Promise<boolean>;
}

export function createVaultGit(root: string, exec: ExecGit = defaultExec): VaultGit {
  // Serialises every git invocation. Concurrent index runs must not interleave
  // add/commit pairs, which would attribute one run's files to another's message.
  let lock: Promise<void> = Promise.resolve();

  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = lock.then(fn, fn);
    lock = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    async available(): Promise<boolean> {
      try {
        await exec(['--version'], root);
        return true;
      } catch {
        return false;
      }
    },

    init(): Promise<void> {
      return serialize(async () => {
        try {
          await exec(['rev-parse', '--git-dir'], root);
          return; // already a repo
        } catch {
          // not a repo yet
        }
        try {
          await exec(['init', '-q'], root);
        } catch {
          // Versioning is a safety net, not a hard dependency. Callers proceed.
        }
      });
    },

    commitAll(message: string): Promise<boolean> {
      return serialize(async () => {
        try {
          await exec(['add', '-A'], root);
          await exec(['commit', '-q', '-m', message], root);
          return true;
        } catch {
          // Either git is missing or there was nothing staged. Both are
          // non-fatal: the Markdown is already written.
          return false;
        }
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/__tests__/brain-git.test.ts`
Expected: PASS, 8 tests.

If the repo-creating tests fail on commit with "Author identity unknown", the sandbox has no global git identity. Add `-c user.email=… -c user.name=…` is **not** the fix — instead set them in the test's `beforeEach` after `init()`, matching `git-branches.test.ts:24`:

```ts
execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
```

- [ ] **Step 5: Commit**

```bash
git add electron/services/brain/git.ts electron/__tests__/brain-git.test.ts
git commit -m "feat(brain): vault git versioning with serialised commits"
```

---

### Task 5: FTS5 index

One index per vault, in its own database file inside the vault. This is where per-account isolation becomes structural: there is no shared table, so there is no query that can cross accounts by omitting a filter.

**Files:**
- Create: `electron/services/brain/search.ts`
- Test: `electron/__tests__/brain-search.test.ts`

**Interfaces:**
- Consumes: `toFtsQuery` (Task 2); `Vault`, `ParsedNote` (Tasks 1, 3).
- Produces: `SearchHit { notePath: string; type: string; title: string; snippet: string; score: number }`; `VaultIndex` with `upsert(notePath, title, note): void`, `remove(notePath): void`, `search(query, opts?): SearchHit[]`, `rebuild(vault): number`, `close(): void`; `createVaultIndex(dbPath: string): VaultIndex`.

- [ ] **Step 1: Write the failing test**

Create `electron/__tests__/brain-search.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVaultIndex, type VaultIndex } from '../services/brain/search';
import { createVault } from '../services/brain/vault';
import type { ParsedNote } from '../services/brain/types';

function note(over: Partial<ParsedNote['frontmatter']> = {}, body = ''): ParsedNote {
  return {
    frontmatter: {
      type: 'Subsystem', aliases: [], keywords: [],
      created: '2026-01-01', updated: '2026-01-01', sources: [], ...over,
    },
    body,
  };
}

describe('vault index', () => {
  let dir: string;
  let index: VaultIndex;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnifex-index-'));
    index = createVaultIndex(join(dir, 'index.db'));
  });

  afterEach(() => {
    index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns nothing for an empty index', () => {
    expect(index.search('anything')).toEqual([]);
  });

  it('finds a note by body text', () => {
    index.upsert('Subsystems/A.md', 'A', note({}, 'the stdio bridge handles permissions'));
    expect(index.search('stdio').map((h) => h.notePath)).toEqual(['Subsystems/A.md']);
  });

  it('finds a note by alias', () => {
    index.upsert('Subsystems/A.md', 'A', note({ aliases: ['permission decider'] }, 'body'));
    expect(index.search('decider')).toHaveLength(1);
  });

  it('finds a note by keyword', () => {
    index.upsert('Subsystems/A.md', 'A', note({ keywords: ['acceptEdits'] }, 'body'));
    expect(index.search('acceptEdits')).toHaveLength(1);
  });

  it('matches hyphenated identifiers as a single token', () => {
    index.upsert('Topics/dep.md', 'dep', note({ type: 'Topic' }, 'node-pty must stay pinned'));
    expect(index.search('node-pty')).toHaveLength(1);
  });

  it('matches underscored identifiers as a single token', () => {
    index.upsert('Topics/dep.md', 'dep', note({ type: 'Topic' }, 'the can_use_tool bridge'));
    expect(index.search('can_use_tool')).toHaveLength(1);
  });

  it('stems English prose so singular finds plural', () => {
    index.upsert('Topics/p.md', 'p', note({ type: 'Topic' }, 'permissions are enforced'));
    expect(index.search('permission')).toHaveLength(1);
  });

  it('ranks a title match above a passing body mention', () => {
    index.upsert('Subsystems/Decider.md', 'Decider', note({}, 'unrelated prose'));
    index.upsert('Topics/Other.md', 'Other', note({ type: 'Topic' }, 'this merely mentions the decider once'));
    expect(index.search('decider')[0].notePath).toBe('Subsystems/Decider.md');
  });

  it('returns a snippet around the match', () => {
    index.upsert('Topics/p.md', 'p', note({ type: 'Topic' }, 'alpha beta stdio gamma delta'));
    expect(index.search('stdio')[0].snippet).toContain('stdio');
  });

  it('upsert replaces rather than duplicating', () => {
    index.upsert('Subsystems/A.md', 'A', note({}, 'first version'));
    index.upsert('Subsystems/A.md', 'A', note({}, 'second version'));
    expect(index.search('version')).toHaveLength(1);
    expect(index.search('first')).toHaveLength(0);
  });

  it('remove deletes a note from the index', () => {
    index.upsert('Subsystems/A.md', 'A', note({}, 'stdio'));
    index.remove('Subsystems/A.md');
    expect(index.search('stdio')).toEqual([]);
  });

  it('filters by note type', () => {
    index.upsert('Subsystems/A.md', 'A', note({}, 'stdio'));
    index.upsert('Topics/B.md', 'B', note({ type: 'Topic' }, 'stdio'));
    expect(index.search('stdio', { type: 'Topic' }).map((h) => h.notePath)).toEqual(['Topics/B.md']);
  });

  it('honours the limit', () => {
    for (let i = 0; i < 5; i++) index.upsert(`Topics/${i}.md`, `${i}`, note({ type: 'Topic' }, 'stdio'));
    expect(index.search('stdio', { limit: 2 })).toHaveLength(2);
  });

  it('returns [] for input that sanitises to nothing, without a SQL error', () => {
    index.upsert('Subsystems/A.md', 'A', note({}, 'stdio'));
    expect(index.search('***')).toEqual([]);
    expect(index.search('')).toEqual([]);
  });

  it('does not throw on input containing FTS5 operators and quotes', () => {
    index.upsert('Subsystems/A.md', 'A', note({}, 'stdio'));
    expect(() => index.search('NEAR("a" OR *b*)')).not.toThrow();
  });

  it('rebuild indexes every note in a vault and reports the count', () => {
    const vault = createVault(join(dir, 'vault'));
    vault.ensureLayout();
    vault.writeNote('Subsystems/A.md', note({}, 'stdio bridge'));
    vault.writeNote('Topics/B.md', note({ type: 'Topic' }, 'unrelated'));

    expect(index.rebuild(vault)).toBe(2);
    expect(index.search('stdio')).toHaveLength(1);
  });

  it('rebuild skips corrupt notes instead of aborting', () => {
    const vault = createVault(join(dir, 'vault'));
    vault.ensureLayout();
    vault.writeNote('Subsystems/Good.md', note({}, 'stdio'));
    // Bypass writeNote so the file is deliberately malformed.
    writeFileSync(join(dir, 'vault', 'Topics', 'Bad.md'), 'no fence\n');

    expect(index.rebuild(vault)).toBe(1);
    expect(index.search('stdio')).toHaveLength(1);
  });

  it('rebuild clears notes that no longer exist', () => {
    const vault = createVault(join(dir, 'vault'));
    vault.ensureLayout();
    index.upsert('Topics/Ghost.md', 'Ghost', note({ type: 'Topic' }, 'stdio'));

    index.rebuild(vault);
    expect(index.search('stdio')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/brain-search.test.ts`
Expected: FAIL — cannot resolve `../services/brain/search`.

- [ ] **Step 3: Write the implementation**

Create `electron/services/brain/search.ts`:

```ts
import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { toFtsQuery } from './fts-query';
import type { ParsedNote } from './types';
import type { Vault } from './vault';
import { NoteParseError } from './frontmatter';

export interface SearchHit {
  notePath: string;
  type: string;
  title: string;
  snippet: string;
  /** Raw bm25 score. More negative is a better match. */
  score: number;
}

export interface SearchOptions {
  type?: string;
  limit?: number;
}

export interface VaultIndex {
  upsert(notePath: string, title: string, note: ParsedNote): void;
  remove(notePath: string): void;
  search(query: string, opts?: SearchOptions): SearchHit[];
  /** Reindex the whole vault from disk. Returns the number of notes indexed. */
  rebuild(vault: Vault): number;
  close(): void;
}

const DEFAULT_LIMIT = 20;

/**
 * Column weights for bm25, in declaration order:
 *   note_path, type, title, aliases, keywords, summary, body
 * UNINDEXED columns get 0. Title, aliases and keywords dominate so that a note
 * which *is* about a subject outranks one that mentions it in passing — the
 * aliases field is what makes FTS5 competitive with semantic search here.
 */
const BM25_WEIGHTS = '0.0, 0.0, 10.0, 8.0, 6.0, 3.0, 1.0';

/** Ordinal of the body column, for snippet(). */
const BODY_COLUMN = 6;

export function createVaultIndex(dbPath: string): VaultIndex {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS brain_fts USING fts5(
      note_path UNINDEXED, type UNINDEXED,
      title, aliases, keywords, summary, body,
      tokenize = "porter unicode61 tokenchars '-_'"
    );
  `);

  const deleteStmt = db.prepare('DELETE FROM brain_fts WHERE note_path = ?');
  const insertStmt = db.prepare(
    `INSERT INTO brain_fts (note_path, type, title, aliases, keywords, summary, body)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const clearStmt = db.prepare('DELETE FROM brain_fts');

  /**
   * The Summary section, used as its own weighted column. Falls back to empty
   * when a note has no Summary heading. Line-scanned rather than regex-matched:
   * "everything until the next H2, or end of file" has no clean JS regex form
   * (there is no \Z anchor), and getting it subtly wrong would silently weight
   * every note's summary as empty.
   */
  function summaryOf(body: string): string {
    const lines = body.split('\n');
    const start = lines.findIndex((l) => /^##\s+Summary\s*$/.test(l));
    if (start === -1) return '';
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^##\s/.test(l));
    return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  }

  function write(notePath: string, title: string, note: ParsedNote): void {
    deleteStmt.run(notePath);
    insertStmt.run(
      notePath,
      note.frontmatter.type,
      title,
      note.frontmatter.aliases.join(' '),
      note.frontmatter.keywords.join(' '),
      summaryOf(note.body),
      note.body,
    );
  }

  return {
    upsert(notePath, title, note): void {
      write(notePath, title, note);
    },

    remove(notePath: string): void {
      deleteStmt.run(notePath);
    },

    search(query: string, opts: SearchOptions = {}): SearchHit[] {
      const match = toFtsQuery(query);
      // An empty MATCH is a syntax error, so bail before touching SQLite.
      if (!match) return [];

      const limit = opts.limit ?? DEFAULT_LIMIT;
      const typeClause = opts.type ? 'AND type = ?' : '';
      const params: unknown[] = opts.type ? [match, opts.type, limit] : [match, limit];

      const rows = db
        .prepare(
          `SELECT note_path AS notePath,
                  type,
                  title,
                  snippet(brain_fts, ${BODY_COLUMN}, '[', ']', '…', 12) AS snippet,
                  bm25(brain_fts, ${BM25_WEIGHTS}) AS score
             FROM brain_fts
            WHERE brain_fts MATCH ?
              ${typeClause}
            ORDER BY score ASC
            LIMIT ?`,
        )
        .all(...params) as SearchHit[];

      return rows;
    },

    rebuild(vault: Vault): number {
      // The index is derived, so a rebuild starts from empty. This is also how
      // notes deleted on disk leave the index.
      clearStmt.run();
      let count = 0;
      for (const relPath of vault.listNotes()) {
        try {
          write(relPath, vault.noteTitle(relPath), vault.readNote(relPath));
          count++;
        } catch (err) {
          // A hand-edited note with broken frontmatter must not abort the scan.
          if (!(err instanceof NoteParseError)) throw err;
        }
      }
      return count;
    },

    close(): void {
      db.close();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/__tests__/brain-search.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/services/brain/search.ts electron/__tests__/brain-search.test.ts
git commit -m "feat(brain): per-vault FTS5 index"
```

---

### Task 6: Migration v18 — orchestration tables

`brain_sources` and `brain_queue` live in `greychrist.db` and carry `account_id`. Note *content* never lives here — only pointers and status — so this table pair is not a hole in the isolation model.

**Files:**
- Modify: `electron/services/database.ts` (append migration `version: 18` to the `migrations` array at line 50; add tables to `initSchema` so fresh installs skip the migration)
- Test: `electron/__tests__/database-migration-v18.test.ts`

**Interfaces:**
- Consumes: `Migration`, `createDatabase` (existing).
- Produces: tables `brain_sources` and `brain_queue`.

- [ ] **Step 1: Write the failing test**

Create `electron/__tests__/database-migration-v18.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';

describe('brain orchestration schema (v18)', () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  function columns(table: string): string[] {
    return (db.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .map((r) => r.name);
  }

  it('creates brain_sources with an account_id', () => {
    expect(columns('brain_sources')).toEqual(
      expect.arrayContaining(['account_id', 'source_id', 'item_key', 'mtime', 'hash', 'last_indexed_at', 'status', 'error']),
    );
  });

  it('creates brain_queue with an account_id', () => {
    expect(columns('brain_queue')).toEqual(
      expect.arrayContaining(['account_id', 'source_id', 'item_key', 'status', 'enqueued_at']),
    );
  });

  it('keys brain_sources by (account_id, source_id, item_key)', () => {
    const insert = db.raw.prepare(
      `INSERT INTO brain_sources (account_id, source_id, item_key, mtime, hash, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run(1, 'session', 'abc', 1, 'h', 'indexed');
    // Same item under a different account is a distinct row, not a conflict.
    expect(() => insert.run(2, 'session', 'abc', 1, 'h', 'indexed')).not.toThrow();
    // Same item under the same account conflicts.
    expect(() => insert.run(1, 'session', 'abc', 1, 'h', 'indexed')).toThrow();
  });

  it('deletes brain rows when the owning account is deleted', () => {
    db.raw.prepare(`INSERT INTO accounts (name, config_dir) VALUES ('a', '/tmp/a')`).run();
    const accountId = (db.raw.prepare(`SELECT id FROM accounts WHERE name = 'a'`).get() as { id: number }).id;

    db.raw.prepare(
      `INSERT INTO brain_queue (account_id, source_id, item_key, status) VALUES (?, 'session', 'k', 'pending')`,
    ).run(accountId);
    db.raw.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);

    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM brain_queue').get()).toEqual({ n: 0 });
  });

  it('records the migration version', () => {
    const row = db.raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(row.v).toBeGreaterThanOrEqual(18);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/database-migration-v18.test.ts`
Expected: FAIL — `no such table: brain_sources`.

- [ ] **Step 3: Add the tables to `initSchema`**

In `electron/services/database.ts`, inside `initSchema`'s `db.exec(...)` template, after the `app_logs` table, add:

```sql
    CREATE TABLE IF NOT EXISTS brain_sources (
      account_id INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      mtime INTEGER,
      hash TEXT,
      last_indexed_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      PRIMARY KEY (account_id, source_id, item_key),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS brain_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      enqueued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      finished_at TEXT,
      UNIQUE (account_id, source_id, item_key),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
```

- [ ] **Step 4: Add migration v18 for existing installs**

Append to the `migrations` array in `electron/services/database.ts` (after `version: 17`). The SQL is identical to Step 3 — `CREATE TABLE IF NOT EXISTS` makes it a no-op on fresh installs that already got the tables from `initSchema`:

```ts
  {
    version: 18,
    name: 'brain-orchestration-tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS brain_sources (
          account_id INTEGER NOT NULL,
          source_id TEXT NOT NULL,
          item_key TEXT NOT NULL,
          mtime INTEGER,
          hash TEXT,
          last_indexed_at TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          error TEXT,
          PRIMARY KEY (account_id, source_id, item_key),
          FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS brain_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL,
          source_id TEXT NOT NULL,
          item_key TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          error TEXT,
          enqueued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          started_at TEXT,
          finished_at TEXT,
          UNIQUE (account_id, source_id, item_key),
          FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
        );
      `);
    },
  },
```

Check the `Migration` interface at `electron/services/database.ts:44` — if it has no `name` field, drop that property.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run electron/__tests__/database-migration-v18.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Run the existing database tests for regressions**

Run: `npx vitest run electron/__tests__/database.test.ts electron/__tests__/database-migration-v11.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add electron/services/database.ts electron/__tests__/database-migration-v18.test.ts
git commit -m "feat(brain): add brain_sources and brain_queue tables (v18)"
```

---

### Task 7: Per-account vault registry

The piece that enforces the top invariant. Every operation names an account; a vault is resolved from that account's `app_settings` entry; and two accounts can never share a vault path.

**Files:**
- Create: `electron/services/brain/registry.ts`
- Test: `electron/__tests__/brain-registry.test.ts`

**Interfaces:**
- Consumes: `Database` (existing, `electron/services/database.ts`); `createVault`, `Vault` (Task 3); `createVaultIndex`, `VaultIndex`, `SearchHit`, `SearchOptions` (Task 5); `createVaultGit`, `VaultGit` (Task 4).
- Produces: `vaultSettingKey(accountId: number): string`; `VaultHandle { accountId, root, vault, index, git }`; `BrainService` with `vaultPath(accountId): string | null`, `setVaultPath(accountId, path): void`, `clearVaultPath(accountId): void`, `open(accountId): VaultHandle | null`, `search(accountId, query, opts?): SearchHit[]`, `writeNote(accountId, relPath, note, commitMessage): void`, `closeAll(): void`; `createBrainService(db: Database): BrainService`; `VaultConflictError`.

- [ ] **Step 1: Write the failing test**

Create `electron/__tests__/brain-registry.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createBrainService, VaultConflictError, type BrainService } from '../services/brain/registry';
import type { ParsedNote } from '../services/brain/types';

function note(body: string, type: ParsedNote['frontmatter']['type'] = 'Subsystem'): ParsedNote {
  return {
    frontmatter: {
      type, aliases: [], keywords: [],
      created: '2026-01-01', updated: '2026-01-01', sources: [],
    },
    body,
  };
}

describe('brain registry', () => {
  let dir: string;
  let db: Database;
  let brain: BrainService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnifex-brain-'));
    db = createDatabase(':memory:');
    brain = createBrainService(db);
  });

  afterEach(() => {
    brain.closeAll();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for an account with no vault configured', () => {
    expect(brain.vaultPath(1)).toBeNull();
    expect(brain.open(1)).toBeNull();
  });

  it('search on an unconfigured account returns [] rather than throwing', () => {
    expect(brain.search(1, 'anything')).toEqual([]);
  });

  it('persists a vault path per account', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    expect(brain.vaultPath(1)).toBe(join(dir, 'personal'));
    expect(brain.vaultPath(2)).toBeNull();
  });

  it('creates the vault layout on open', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    const handle = brain.open(1);
    expect(handle).not.toBeNull();
    expect(handle!.root).toBe(join(dir, 'personal'));
    expect(existsSync(join(dir, 'personal', 'Subsystems'))).toBe(true);
  });

  it('rejects assigning one vault path to two accounts', () => {
    brain.setVaultPath(1, join(dir, 'shared'));
    expect(() => brain.setVaultPath(2, join(dir, 'shared'))).toThrow(VaultConflictError);
  });

  it('allows reassigning the same path to the same account', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    expect(() => brain.setVaultPath(1, join(dir, 'personal'))).not.toThrow();
  });

  it('frees a path once cleared', () => {
    brain.setVaultPath(1, join(dir, 'shared'));
    brain.clearVaultPath(1);
    expect(() => brain.setVaultPath(2, join(dir, 'shared'))).not.toThrow();
  });

  it('writes a note and finds it via search', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.writeNote(1, 'Subsystems/A.md', note('the stdio bridge'), 'Manual edit');
    expect(brain.search(1, 'stdio').map((h) => h.notePath)).toEqual(['Subsystems/A.md']);
  });

  it('ISOLATION: a note written to one account is invisible to another', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.setVaultPath(2, join(dir, 'work'));

    brain.writeNote(1, 'Subsystems/Personal.md', note('personal stdio secret'), 'Manual edit');
    brain.writeNote(2, 'Subsystems/Work.md', note('work stdio secret'), 'Manual edit');

    expect(brain.search(1, 'stdio').map((h) => h.notePath)).toEqual(['Subsystems/Personal.md']);
    expect(brain.search(2, 'stdio').map((h) => h.notePath)).toEqual(['Subsystems/Work.md']);
  });

  it('ISOLATION: each vault gets its own index database file', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.setVaultPath(2, join(dir, 'work'));
    brain.open(1);
    brain.open(2);

    expect(existsSync(join(dir, 'personal', '.omnifex', 'index.db'))).toBe(true);
    expect(existsSync(join(dir, 'work', '.omnifex', 'index.db'))).toBe(true);
  });

  it('reuses one handle per account rather than reopening', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    expect(brain.open(1)).toBe(brain.open(1));
  });

  it('drops the cached handle when the path changes', () => {
    brain.setVaultPath(1, join(dir, 'first'));
    const first = brain.open(1);
    brain.setVaultPath(1, join(dir, 'second'));
    expect(brain.open(1)).not.toBe(first);
    expect(brain.open(1)!.root).toBe(join(dir, 'second'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/brain-registry.test.ts`
Expected: FAIL — cannot resolve `../services/brain/registry`.

- [ ] **Step 3: Add the git-failure logger**

Create `electron/services/brain/git-logging.ts`:

```ts
/**
 * Swallow and log a background git operation. Versioning is auxiliary: a
 * missing git binary or a locked index must never reject into a caller that
 * has already written the Markdown successfully.
 */
export function fireAndLogGitFailure(p: Promise<unknown>, label: string): void {
  void p.catch((err) => {
    console.warn(`${label} failed:`, err);
  });
}
```

- [ ] **Step 4: Write the registry**

Create `electron/services/brain/registry.ts`:

```ts
import { join, resolve } from 'node:path';
import type { Database } from '../database';
import { createVault, type Vault } from './vault';
import { createVaultIndex, type SearchHit, type SearchOptions, type VaultIndex } from './search';
import { createVaultGit, type VaultGit } from './git';
import { fireAndLogGitFailure } from './git-logging';
import type { ParsedNote } from './types';

/** Thrown when a vault path is already claimed by a different account. */
export class VaultConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultConflictError';
  }
}

/** app_settings key holding one account's vault root. */
export function vaultSettingKey(accountId: number): string {
  return `brain.vault.${accountId}`;
}

export interface VaultHandle {
  readonly accountId: number;
  readonly root: string;
  readonly vault: Vault;
  readonly index: VaultIndex;
  readonly git: VaultGit;
}

export interface BrainService {
  vaultPath(accountId: number): string | null;
  setVaultPath(accountId: number, path: string): void;
  clearVaultPath(accountId: number): void;
  /** Opens (and lazily creates) the account's vault. Null when unconfigured. */
  open(accountId: number): VaultHandle | null;
  search(accountId: number, query: string, opts?: SearchOptions): SearchHit[];
  writeNote(accountId: number, relPath: string, note: ParsedNote, commitMessage: string): void;
  closeAll(): void;
}

export function createBrainService(db: Database): BrainService {
  // One handle per account. Keyed by accountId, invalidated when its path moves.
  const handles = new Map<number, VaultHandle>();

  function readPath(accountId: number): string | null {
    return db.getSetting(vaultSettingKey(accountId));
  }

  function closeHandle(accountId: number): void {
    const existing = handles.get(accountId);
    if (existing) {
      existing.index.close();
      handles.delete(accountId);
    }
  }

  const service: BrainService = {
    vaultPath(accountId: number): string | null {
      return readPath(accountId);
    },

    setVaultPath(accountId: number, path: string): void {
      const target = resolve(path);

      // Two accounts sharing a vault would defeat the whole isolation model, so
      // this is rejected at configuration time rather than guarded downstream.
      const rows = db.raw
        .prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'brain.vault.%'`)
        .all() as { key: string; value: string }[];
      for (const row of rows) {
        if (row.key === vaultSettingKey(accountId)) continue;
        if (resolve(row.value) === target) {
          throw new VaultConflictError(
            `vault path is already assigned to another account: ${target}`,
          );
        }
      }

      closeHandle(accountId);
      db.saveSetting(vaultSettingKey(accountId), path);
    },

    clearVaultPath(accountId: number): void {
      closeHandle(accountId);
      db.raw.prepare('DELETE FROM app_settings WHERE key = ?').run(vaultSettingKey(accountId));
    },

    open(accountId: number): VaultHandle | null {
      const path = readPath(accountId);
      // No configured vault is an ordinary state, not an error: indexing for
      // this account is simply inert.
      if (!path) return null;

      const cached = handles.get(accountId);
      if (cached && cached.root === resolve(path)) return cached;
      if (cached) closeHandle(accountId);

      const vault = createVault(path);
      vault.ensureLayout();

      const git = createVaultGit(vault.root);
      // Versioning is a safety net; a missing git binary must not block a write.
      fireAndLogGitFailure(git.init(), 'brain: git init');

      const index = createVaultIndex(join(vault.root, '.omnifex', 'index.db'));

      const handle: VaultHandle = { accountId, root: vault.root, vault, index, git };
      handles.set(accountId, handle);
      return handle;
    },

    search(accountId: number, query: string, opts?: SearchOptions): SearchHit[] {
      const handle = service.open(accountId);
      if (!handle) return [];
      return handle.index.search(query, opts);
    },

    writeNote(accountId: number, relPath: string, note: ParsedNote, commitMessage: string): void {
      const handle = service.open(accountId);
      if (!handle) {
        // No silent fallback to another account's vault.
        throw new Error(`no vault configured for account ${accountId}`);
      }
      handle.vault.writeNote(relPath, note);
      handle.index.upsert(relPath, handle.vault.noteTitle(relPath), note);
      fireAndLogGitFailure(handle.git.commitAll(commitMessage), 'brain: commit');
    },

    closeAll(): void {
      for (const accountId of [...handles.keys()]) closeHandle(accountId);
    },
  };

  return service;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run electron/__tests__/brain-registry.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
git add electron/services/brain/registry.ts electron/services/brain/git-logging.ts electron/__tests__/brain-registry.test.ts
git commit -m "feat(brain): per-account vault registry with structural isolation"
```

---

### Task 8: IPC surface

Exposes the registry to the renderer so Plan 2 (Brain tab) is pure UI. Every channel takes an explicit `accountId` — there is no implicit current-account default, because a wrong default here is a confidentiality failure rather than a UX annoyance.

**Files:**
- Create: `electron/ipc/brain-handlers.ts`
- Modify: `electron/ipc/handlers.ts` (add `brain?` to `Services` at line 17; spread the brain map into `getHandlerMap`'s returned `map` at line 349)
- Modify: `electron/main.ts` (construct `createBrainService(db)`, pass in the services object)
- Modify: `electron/preload.ts` (add six channels to the invoke allow-list)
- Modify: `src/lib/api.ts` (typed renderer wrappers)
- Test: `electron/__tests__/brain-ipc.test.ts`

**Interfaces:**
- Consumes: `BrainService`, `SearchHit` (Task 7); `HandlerFn = (event: unknown, params?: Record<string, unknown>) => Promise<unknown>` (existing, `electron/ipc/handlers.ts:270`); `apiCall<T>(command: string, params?: Record<string, unknown>): Promise<T>` and `stripUndefined` (existing, `src/lib/apiAdapter.ts:11` and `src/lib/api.ts:6`).
- Produces: `createBrainHandlers(brain?: BrainService): Record<string, HandlerFn>`; channels `brain_vault_path`, `brain_set_vault_path`, `brain_clear_vault_path`, `brain_search`, `brain_list_notes`, `brain_read_note`; renderer functions `brainVaultPath`, `brainSetVaultPath`, `brainClearVaultPath`, `brainSearch`, `brainListNotes`, `brainReadNote`.

- [ ] **Step 1: Write the failing test**

Create `electron/__tests__/brain-ipc.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createBrainService, type BrainService } from '../services/brain/registry';
import { createBrainHandlers } from '../ipc/brain-handlers';
import { getHandlerMap } from '../ipc/handlers';
import type { ParsedNote } from '../services/brain/types';

const NOTE: ParsedNote = {
  frontmatter: {
    type: 'Subsystem', aliases: ['decider'], keywords: [],
    created: '2026-01-01', updated: '2026-01-01', sources: [],
  },
  body: '# A\n\n## Summary\nthe stdio bridge\n',
};

const CHANNELS = [
  'brain_clear_vault_path',
  'brain_list_notes',
  'brain_read_note',
  'brain_search',
  'brain_set_vault_path',
  'brain_vault_path',
];

describe('brain IPC handlers', () => {
  let dir: string;
  let db: Database;
  let brain: BrainService;
  let handlers: Record<string, (event: unknown, params?: Record<string, unknown>) => Promise<unknown>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnifex-brain-ipc-'));
    db = createDatabase(':memory:');
    brain = createBrainService(db);
    handlers = createBrainHandlers(brain);
  });

  afterEach(() => {
    brain.closeAll();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('exposes exactly the expected channels', () => {
    expect(Object.keys(handlers).sort()).toEqual(CHANNELS);
  });

  it('is wired into the main handler map', () => {
    const map = getHandlerMap({ brain } as Parameters<typeof getHandlerMap>[0]);
    for (const channel of CHANNELS) expect(map[channel]).toBeTypeOf('function');
  });

  it('round-trips the vault path', async () => {
    await handlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'personal') });
    expect(await handlers.brain_vault_path(null, { accountId: 1 })).toBe(join(dir, 'personal'));
  });

  it('accepts snake_case params as well as camelCase', async () => {
    await handlers.brain_set_vault_path(null, { account_id: 1, path: join(dir, 'personal') });
    expect(await handlers.brain_vault_path(null, { account_id: 1 })).toBe(join(dir, 'personal'));
  });

  it('searches within one account only', async () => {
    await handlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'personal') });
    await handlers.brain_set_vault_path(null, { accountId: 2, path: join(dir, 'work') });
    brain.writeNote(1, 'Subsystems/A.md', NOTE, 'Manual edit');

    expect(await handlers.brain_search(null, { accountId: 1, query: 'stdio' })).toHaveLength(1);
    expect(await handlers.brain_search(null, { accountId: 2, query: 'stdio' })).toEqual([]);
  });

  it('lists and reads notes for an account', async () => {
    await handlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'personal') });
    brain.writeNote(1, 'Subsystems/A.md', NOTE, 'Manual edit');

    expect(await handlers.brain_list_notes(null, { accountId: 1 })).toEqual(['Subsystems/A.md']);
    const read = (await handlers.brain_read_note(null, {
      accountId: 1, notePath: 'Subsystems/A.md',
    })) as ParsedNote;
    expect(read.frontmatter.aliases).toEqual(['decider']);
  });

  it('returns [] rather than throwing for an unconfigured account', async () => {
    expect(await handlers.brain_search(null, { accountId: 99, query: 'x' })).toEqual([]);
    expect(await handlers.brain_list_notes(null, { accountId: 99 })).toEqual([]);
  });

  it('rejects a missing accountId instead of defaulting', async () => {
    await expect(handlers.brain_search(null, { query: 'x' })).rejects.toThrow(/accountId/);
  });

  it('returns inert results when no brain service is wired at all', async () => {
    const none = createBrainHandlers(undefined);
    expect(await none.brain_search(null, { accountId: 1, query: 'x' })).toEqual([]);
    expect(await none.brain_vault_path(null, { accountId: 1 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/brain-ipc.test.ts`
Expected: FAIL — cannot resolve `../ipc/brain-handlers`.

- [ ] **Step 3: Write the handler module**

Create `electron/ipc/brain-handlers.ts`:

```ts
import type { BrainService } from '../services/brain/registry';
import { NoteParseError } from '../services/brain/frontmatter';

type Params = Record<string, unknown>;

/** Matches the existing HandlerFn shape in handlers.ts:270. */
type HandlerFn = (event: unknown, params?: Params) => Promise<unknown>;

/**
 * accountId is always required. Defaulting it would risk reading or writing the
 * wrong account's vault, which is a confidentiality failure rather than a UX
 * annoyance — so this throws instead of falling back.
 *
 * Both camelCase and snake_case are accepted, matching the repo convention.
 */
function requireAccountId(params: Params): number {
  const raw = params.accountId ?? params.account_id;
  const id = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof id !== 'number' || !Number.isFinite(id)) {
    throw new Error('accountId is required');
  }
  return id;
}

function requireString(params: Params, camel: string, snake: string): string {
  const value = params[camel] ?? params[snake];
  if (typeof value !== 'string' || !value) throw new Error(`${camel} is required`);
  return value;
}

/**
 * `brain` is optional so the app still boots if the service failed to
 * construct — the Brain is auxiliary and must never break IPC registration.
 */
export function createBrainHandlers(brain?: BrainService): Record<string, HandlerFn> {
  return {
    async brain_vault_path(_event, params = {}) {
      return brain?.vaultPath(requireAccountId(params)) ?? null;
    },

    async brain_set_vault_path(_event, params = {}) {
      brain?.setVaultPath(requireAccountId(params), requireString(params, 'path', 'path'));
      return null;
    },

    async brain_clear_vault_path(_event, params = {}) {
      brain?.clearVaultPath(requireAccountId(params));
      return null;
    },

    async brain_search(_event, params = {}) {
      const accountId = requireAccountId(params);
      if (!brain) return [];
      const query = typeof params.query === 'string' ? params.query : '';
      const type = typeof params.type === 'string' ? params.type : undefined;
      const limit = typeof params.limit === 'number' ? params.limit : undefined;
      return brain.search(accountId, query, { type, limit });
    },

    async brain_list_notes(_event, params = {}) {
      const handle = brain?.open(requireAccountId(params));
      return handle ? handle.vault.listNotes() : [];
    },

    async brain_read_note(_event, params = {}) {
      const handle = brain?.open(requireAccountId(params));
      if (!handle) throw new Error('no vault configured for this account');
      const notePath = requireString(params, 'notePath', 'note_path');
      try {
        return handle.vault.readNote(notePath);
      } catch (err) {
        // Surface a corrupt note as a readable message rather than a stack.
        if (err instanceof NoteParseError) throw new Error(`cannot read note: ${err.message}`);
        throw err;
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/__tests__/brain-ipc.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Wire the handlers into the IPC registry**

In `electron/ipc/handlers.ts`:

1. Add the import at the top:

```ts
import { createBrainHandlers } from './brain-handlers';
import type { BrainService } from '../services/brain/registry';
```

2. Add the field to the `Services` interface (line 17). Unlike the other entries — which are structural `{ method(): unknown }` shapes — this one references the real type, because `BrainService` is defined in this repo and there is no reason to restate it:

```ts
  brain?: BrainService;
```

3. In `getHandlerMap` (line 323), add `brain` to the destructuring on the first line, then spread the handlers into the returned `map` object literal (line 349):

```ts
  const map: Record<string, HandlerFn> = {
    ...createBrainHandlers(brain),
    // …existing entries unchanged
```

Spreading first means an existing channel would win a name collision — a safety property, since the `brain_` prefix should make collisions impossible and a silent override of an existing channel would be far worse than a duplicated Brain one.

In `electron/main.ts`, construct the service alongside the other services and include it in the object passed to `registerIpcHandlers(...)`:

```ts
import { createBrainService } from './services/brain/registry';
// …
const brainService = createBrainService(db);
// …then add `brain: brainService,` to the services object literal.
```

- [ ] **Step 6: Add the channels to the preload allow-list**

In `electron/preload.ts`, add to the invoke allow-list array:

```ts
  'brain_vault_path',
  'brain_set_vault_path',
  'brain_clear_vault_path',
  'brain_search',
  'brain_list_notes',
  'brain_read_note',
```

- [ ] **Step 7: Verify the channel contract test still passes**

Run: `npx vitest run electron/__tests__/ipc-channel-contract.test.ts electron/__tests__/ipc-handlers.test.ts`
Expected: PASS. This test guards that every registered handler is in the preload allow-list — if it fails, a channel name is missing or misspelled in one of the two lists.

- [ ] **Step 8: Add the typed renderer API**

In `src/lib/api.ts`, add. This uses `apiCall` (imported at line 1) and the file's existing `stripUndefined` helper (line 6) — not a bare `invoke`:

```ts
/** Mirrors the backend `SearchHit` in electron/services/brain/search.ts. */
export interface BrainSearchHit {
  notePath: string;
  type: string;
  title: string;
  snippet: string;
  /** Raw bm25 score. More negative is a better match. */
  score: number;
}

/** Mirrors the backend `ParsedNote` in electron/services/brain/types.ts. */
export interface BrainNote {
  frontmatter: {
    type: string;
    project?: string;
    aliases: string[];
    keywords: string[];
    created: string;
    updated: string;
    curated_at?: string;
    sources: string[];
  };
  body: string;
}

export function brainVaultPath(accountId: number): Promise<string | null> {
  return apiCall('brain_vault_path', { accountId });
}

export function brainSetVaultPath(accountId: number, path: string): Promise<void> {
  return apiCall('brain_set_vault_path', { accountId, path });
}

export function brainClearVaultPath(accountId: number): Promise<void> {
  return apiCall('brain_clear_vault_path', { accountId });
}

export function brainSearch(
  accountId: number,
  query: string,
  opts: { type?: string; limit?: number } = {},
): Promise<BrainSearchHit[]> {
  return apiCall('brain_search', stripUndefined({
    accountId,
    query,
    type: opts.type,
    limit: opts.limit,
  }));
}

export function brainListNotes(accountId: number): Promise<string[]> {
  return apiCall('brain_list_notes', { accountId });
}

export function brainReadNote(accountId: number, notePath: string): Promise<BrainNote> {
  return apiCall('brain_read_note', { accountId, notePath });
}
```

- [ ] **Step 9: Full verification gate**

This is a cross-cutting change, so run all three:

```bash
npm run check
npm run build
npm run test:coverage
```

Expected: all pass. Then, before launching the app:

```bash
npm run rebuild:electron
```

- [ ] **Step 10: Commit**

```bash
git add electron/ipc/brain-handlers.ts electron/ipc/handlers.ts electron/main.ts electron/preload.ts src/lib/api.ts electron/__tests__/brain-ipc.test.ts
git commit -m "feat(brain): IPC surface for the vault registry"
```

- [ ] **Step 11: Correct the spec's dependency claim**

The spec asserts "no new dependencies", which this plan invalidates by adding `js-yaml`. In `docs/superpowers/specs/2026-08-11-brain-memory-vault-design.md`, replace the sentence beginning "**No new dependencies.**" with:

> **One new dependency.** `js-yaml` is added for frontmatter parsing — it is present only transitively under eslint today, and hand-rolling a parser would reintroduce the regex-scraping bug class YAML was chosen to remove. Everything else is already in: `zod` covers extraction schemas, `better-sqlite3` provides FTS5, `@uiw/react-md-editor` covers the tab's editor, and git is driven by spawning the system binary through an injectable exec, matching `git-branches.ts:1` and `git-worktrees.ts:5`.

```bash
git add docs/superpowers/specs/2026-08-11-brain-memory-vault-design.md
git commit -m "docs: correct the Brain spec's dependency claim"
```

---

## Done when

- `npm run check`, `npm run build`, and `npm run test:coverage` all pass.
- Two accounts can be pointed at two vaults, and a search against one never returns the other's notes — asserted by the isolation tests in Task 7.
- A vault directory opens in Obsidian and reads as ordinary Markdown.
- No LLM has been invoked anywhere, and no API budget has been spent.

## Not in this plan

Brain tab UI (Plan 2) · session transcript adapter and distillation (Plan 3) · extraction, merge and the index queue (Plan 4) · MCP server, `/recall`, capture adapter (Plan 5) · repo-artifact and auto-memory adapters (Plan 6) · curation (Plan 7).
