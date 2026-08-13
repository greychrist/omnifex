# Brain Plan 7 — curation and vault statistics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the one Brain pass that removes rather than adds — collapsing a note's old Timeline into a summary and promoting recurring facts — plus the vault statistics surface that says whether it is firing at the right time.

**Architecture:** A model returns validated JSON; a pure fold applies it. `curate.ts` decides deterministically which Timeline entries collapse and computes their date range; the model supplies only prose and promoted facts. Work reaches the existing queue worker as `(accountId, 'curation', notePath)` rows, so curation inherits concurrency 1, yield-to-active-session, pause, orphan recovery and per-item failure isolation without new machinery.

**Tech Stack:** TypeScript, Electron main process, `better-sqlite3`, zod, Vitest, React 18 + Tailwind v4 renderer.

**Spec:** `docs/superpowers/specs/2026-08-12-brain-curation-design.md`
**Parent spec:** `docs/superpowers/specs/2026-08-11-brain-memory-vault-design.md`

## Global Constraints

- **TDD is required.** Write the failing test first, run it, watch it fail, then implement. Non-negotiable in this repo.
- **Backend tests live in `electron/__tests__/*.test.ts`.** Coverage target 80% lines.
- **The model never chooses what to delete.** `curate()` picks the entries; the model writes prose about them. Any change that lets model output decide which entries disappear is a defect, not a refactor.
- **Automated writes never touch human sections.** `Open items` and `Assistant notes` are carried through verbatim, always.
- **Purity.** `curate.ts` and `stats.ts` do no I/O, call no model, and read no clock. Dates arrive as parameters. A function that reads `Date.now()` turns its own idempotency test into a race against midnight.
- **Every new invoke channel goes in `electron/ipc/channels.ts`**, which `electron/preload.ts` imports. `ipc-channel-contract.test.ts` fails if a channel has no handler.
- **Strip `undefined` optional params before crossing IPC** (renderer side).
- **Handler adapters accept camelCase and snake_case**: `params.notePath ?? params.note_path`.
- **Refactors clean up after themselves.** When Task 3 renames the worker dependency, every call site changes in that same task. No compatibility shim.
- **Model pin:** `CURATION_MODEL = 'claude-opus-5'`, declared in `curation.ts`, never inherited from `EXTRACTION_MODEL`.
- **Constants:** `MIN_TIMELINE_ENTRIES = 8`, `RETAIN_RECENT = 5`, `COOLDOWN_DAYS = 7`, `MAX_NOTES_PER_RUN = 8`. These are §10's inherited numbers and Task 9 is where they get judged against real measurement.
- **Verification gate:** cross-cutting — `npm run check`, `npm run build`, `npm run test:coverage`, then `npm run rebuild:electron`.
- **Branch:** work happens on `feat/brain-curation` in the main checkout. **No worktrees for this repo.**

## Verified facts (measured 2026-08-12 — do not re-derive)

- `merge.ts` keeps `parseSections`, `renderBody`, `union`, `appendUnique` and `SECTION_ORDER` module-private. Tasks 1 exports the four it needs; there must not be a second Markdown section parser in the codebase.
- `NoteFrontmatter.curated_at` already exists in `electron/services/brain/types.ts:23`, already round-trips through `frontmatter.ts:24` (parse) and `frontmatter.ts:69` (serialize), and **has never had a writer**. Task 1 is its first.
- `extract.ts`'s `firstJsonObject` is module-private. Task 2 exports it rather than writing a second brace-counting JSON extractor.
- Translated auto-memory notes have bodies of the form `## Summary\n\n<description>\n\n<original prose>\n` (`sources/auto-memory.ts:120`). **They have no `## Timeline` section at all**, which is what makes the shape guard in `qualifies()` exclude them for free.
- `merge.ts` writes Timeline bullets as `- **YYYY-MM-DD**: text` and sorts them by that leading date (`merge.ts:134-142`).
- `BrainService.writeNote(accountId, relPath, note, commitMessage)` already does write + index upsert + commit (`registry.ts:813-819`).
- The worker's only dependency on work-shape today is `QueueWorkerDeps.indexSource` (`queue.ts:203-207`), called at `queue.ts:245`. Constructed at `registry.ts:469-477`. Test call sites: `brain-queue.test.ts:201` and `:314`.
- `main.ts:770-784` is the auto-index block on session close. `db.getSetting(...) === 'true'` is the settings idiom.

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `electron/services/brain/curate.ts` | Pure: `qualifies()`, `collapsibleEntries()`, `curate()`, the four constants. `merge.ts`'s twin. |
| `electron/services/brain/curation.ts` | Model side: `CurationResultSchema`, `parseCuration()`, `buildCurationPrompt()`, `CURATION_MODEL`, `createCurator()`. `extract.ts`'s twin. |
| `electron/services/brain/stats.ts` | Pure: `computeVaultStats()`. |
| `src/components/brain/BrainStatsPanel.tsx` | Vault size, context cost, Timeline distribution, recently-curated list. |
| `electron/__tests__/brain-curate.test.ts` | Task 1. |
| `electron/__tests__/brain-curation.test.ts` | Task 2. |
| `electron/__tests__/brain-stats.test.ts` | Task 5. |
| `electron/__tests__/brain-curation-registry.test.ts` | Tasks 4 and 5's registry surface. |

**Modify:**

| File | Change |
|---|---|
| `electron/services/brain/merge.ts` | Export `parseSections`, `renderBody`, `union`, `appendUnique`. |
| `electron/services/brain/extract.ts` | Export `firstJsonObject`. |
| `electron/services/brain/queue.ts` | `indexSource` dep → `process(entry)`; add `CURATION_SOURCE_ID`, `BRAIN_CURATE_SETTING_KEY`. |
| `electron/services/brain/registry.ts` | `curator` option; `curateNote`, `enqueueCuration`, `stats` on `BrainService`; worker dispatch. |
| `electron/__tests__/brain-queue.test.ts` | Update the two worker constructions to `process`. |
| `electron/ipc/channels.ts` | Three channels. |
| `electron/ipc/brain-handlers.ts` | Three handlers. |
| `src/lib/api.ts` | `BrainVaultStats` type + three methods. |
| `electron/main.ts` | Enqueue curation on session close; pass `createCurator()`. |
| `src/components/brain/BrainQueuePanel.tsx` | "Curate" switch. |
| `src/components/brain/BrainTab.tsx` | Render `BrainStatsPanel`. |
| `docs/superpowers/plans/2026-08-11-brain-vault-followups.md` | Task 9 findings. |

---

## Task 1: `curate.ts` — the pure fold

**Files:**
- Create: `electron/services/brain/curate.ts`
- Modify: `electron/services/brain/merge.ts` (export four helpers)
- Test: `electron/__tests__/brain-curate.test.ts`

**Interfaces:**
- Consumes: `ParsedNote`, `NoteFrontmatter` from `./types`.
- Produces:
  ```ts
  export const MIN_TIMELINE_ENTRIES = 8;
  export const RETAIN_RECENT = 5;
  export const COOLDOWN_DAYS = 7;
  export const MAX_NOTES_PER_RUN = 8;
  export interface CurationResult { collapsed: string; promotedFacts: string[] }
  export function qualifies(note: ParsedNote, today: string): boolean;
  export function collapsibleEntries(note: ParsedNote): string[];
  export function curate(note: ParsedNote, result: CurationResult, opts: { date: string }): ParsedNote;
  ```
  `CurationResult` is declared here (not in `curation.ts`) so the pure fold does not import the model module. Task 2's zod schema infers the same shape and Task 2 asserts they match.

- [ ] **Step 1: Export the four helpers from `merge.ts`**

Change four declarations in `electron/services/brain/merge.ts` — add `export` to each, changing nothing else:

```ts
export function parseSections(body: string): { title: string | null; sections: Sections } {
export function renderBody(title: string, sections: Sections): string {
export function union(existing: readonly string[], incoming: readonly string[]): string[] {
export function appendUnique(existing: readonly string[], incoming: readonly string[]): string[] {
```

Also export the `Sections` type alias so `curate.ts` can name it:

```ts
export type Sections = Map<string, string[]>;
```

Add this comment above `parseSections`:

```ts
/**
 * Exported for `curate.ts`, which folds into the same seven-section shape.
 * A second Markdown section parser would drift from this one, and the two
 * would disagree about a note neither had a test for.
 */
```

- [ ] **Step 2: Write the failing tests**

Create `electron/__tests__/brain-curate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  COOLDOWN_DAYS,
  MIN_TIMELINE_ENTRIES,
  RETAIN_RECENT,
  collapsibleEntries,
  curate,
  qualifies,
} from '../services/brain/curate';
import { serializeNote } from '../services/brain/frontmatter';
import type { ParsedNote } from '../services/brain/types';

/** A note with `count` dated Timeline entries, dated 2026-01-01 onward. */
function noteWith(count: number, extra: Partial<ParsedNote['frontmatter']> = {}): ParsedNote {
  const entries = Array.from({ length: count }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    return `- **2026-01-${day}**: Entry number ${String(i + 1)}.`;
  });
  return {
    frontmatter: {
      type: 'Subsystem',
      aliases: ['alpha'],
      keywords: ['beta'],
      created: '2026-01-01',
      updated: '2026-02-01',
      sources: ['session:a'],
      ...extra,
    },
    body: [
      '# Widget',
      '',
      '## Summary',
      'A widget.',
      '',
      '## Connected to',
      '- [[Projects/omnifex]] — belongs to',
      '',
      '## Timeline',
      ...entries,
      '',
      '## Decisions',
      '- **2026-01-02**: Chose the widget.',
      '',
      '## Key facts',
      '- Widgets are load-bearing.',
      '',
      '## Open items',
      '- Ask Greg about the flange.',
      '',
      '## Assistant notes',
      'Handle with care.',
      '',
    ].join('\n'),
  };
}

const RESULT = {
  collapsed: 'Early widget work: the flange was specified and then revised twice.',
  promotedFacts: ['The flange is revised roughly monthly.'],
};

describe('qualifies', () => {
  it('is true for a long, never-curated note', () => {
    expect(qualifies(noteWith(MIN_TIMELINE_ENTRIES), '2026-03-01')).toBe(true);
  });

  it('is false below the entry threshold', () => {
    expect(qualifies(noteWith(MIN_TIMELINE_ENTRIES - 1), '2026-03-01')).toBe(false);
  });

  it('is false when nothing changed since the last curation', () => {
    const note = noteWith(20, { updated: '2026-02-01', curated_at: '2026-02-01' });
    expect(qualifies(note, '2026-06-01')).toBe(false);
  });

  it('is false inside the cooldown even when the note changed', () => {
    const note = noteWith(20, { updated: '2026-03-05', curated_at: '2026-03-01' });
    expect(qualifies(note, `2026-03-0${String(1 + COOLDOWN_DAYS - 1)}`)).toBe(false);
  });

  it('is true once the cooldown has elapsed and the note changed', () => {
    const note = noteWith(20, { updated: '2026-03-05', curated_at: '2026-03-01' });
    expect(qualifies(note, '2026-03-09')).toBe(true);
  });

  it('is false for a note with no Timeline section at all', () => {
    // This is the shape every translated auto-memory note has.
    const freeform: ParsedNote = {
      frontmatter: {
        type: 'Note',
        aliases: [],
        keywords: [],
        created: '2026-01-01',
        updated: '2026-02-01',
        sources: ['auto-memory:x/y.md'],
      },
      body: '## Summary\n\nA memory.\n\nSome prose.\n',
    };
    expect(qualifies(freeform, '2026-06-01')).toBe(false);
  });

  it('does not block forever on an unparseable curated_at', () => {
    const note = noteWith(20, { updated: '2026-03-05', curated_at: 'not-a-date' });
    expect(qualifies(note, '2026-06-01')).toBe(true);
  });
});

describe('collapsibleEntries', () => {
  it('is every dated entry except the newest RETAIN_RECENT', () => {
    const entries = collapsibleEntries(noteWith(12));
    expect(entries).toHaveLength(12 - RETAIN_RECENT);
    expect(entries[0]).toContain('Entry number 1.');
    expect(entries[entries.length - 1]).toContain(`Entry number ${String(12 - RETAIN_RECENT)}.`);
  });
});

describe('curate', () => {
  it('replaces the collapsed span with one dated-range entry and keeps the recent tail', () => {
    const out = curate(noteWith(12), RESULT, { date: '2026-03-01' });
    const timeline = out.body.split('## Timeline\n')[1].split('\n## ')[0].trim().split('\n');

    expect(timeline).toHaveLength(1 + RETAIN_RECENT);
    expect(timeline[0]).toBe(
      `- **2026-01-01 – 2026-01-07**: ${RESULT.collapsed} _(7 entries collapsed)_`,
    );
    expect(timeline[1]).toContain('Entry number 8.');
    expect(timeline[timeline.length - 1]).toContain('Entry number 12.');
  });

  it('promotes facts into Key facts without disturbing what is there', () => {
    const out = curate(noteWith(12), RESULT, { date: '2026-03-01' });
    const facts = out.body.split('## Key facts\n')[1].split('\n## ')[0].trim().split('\n');
    expect(facts).toEqual([
      '- Widgets are load-bearing.',
      '- The flange is revised roughly monthly.',
    ]);
  });

  it('never writes the human sections', () => {
    const out = curate(noteWith(12), RESULT, { date: '2026-03-01' });
    expect(out.body).toContain('- Ask Greg about the flange.');
    expect(out.body).toContain('Handle with care.');
  });

  it('stamps curated_at and leaves updated alone', () => {
    const out = curate(noteWith(12), RESULT, { date: '2026-03-01' });
    expect(out.frontmatter.curated_at).toBe('2026-03-01');
    // Curation is not a source event. `updated` means "latest source this note
    // has seen"; bumping it here would make a compressed note look freshly
    // sourced, and would also defeat the freshness guard in `qualifies`.
    expect(out.frontmatter.updated).toBe('2026-02-01');
  });

  it('takes the date range from the entries, not from the model', () => {
    const evil = { collapsed: '**1999-01-01 – 1999-12-31**: nope', promotedFacts: [] };
    const out = curate(noteWith(12), evil, { date: '2026-03-01' });
    expect(out.body).toContain('- **2026-01-01 – 2026-01-07**:');
    expect(out.body).not.toContain('1999-01-01 – 1999-12-31**: nope _(');
  });

  it('flattens model prose that contains headings or newlines', () => {
    const messy = { collapsed: '## Heading\nline one\n\nline two', promotedFacts: [] };
    const out = curate(noteWith(12), messy, { date: '2026-03-01' });
    expect(out.body).toContain('- **2026-01-01 – 2026-01-07**: Heading line one line two _(7 entries collapsed)_');
    // A heading inside a bullet would restructure the note, which is exactly
    // what the structured path exists to prevent.
    expect(out.body).not.toContain('\n## Heading');
  });

  it('is byte-identical across repeated calls and does not mutate its input', () => {
    const note = noteWith(12);
    const before = serializeNote(note);
    const a = serializeNote(curate(note, RESULT, { date: '2026-03-01' }));
    const b = serializeNote(curate(note, RESULT, { date: '2026-03-01' }));
    expect(a).toBe(b);
    expect(serializeNote(note)).toBe(before);
  });

  it('stamps curated_at and changes nothing else when there is nothing to collapse', () => {
    const note = noteWith(RETAIN_RECENT);
    const out = curate(note, RESULT, { date: '2026-03-01' });
    expect(out.frontmatter.curated_at).toBe('2026-03-01');
    expect(out.body).toBe(note.body);
  });

  it('preserves hand-written undated Timeline lines', () => {
    const note = noteWith(12);
    note.body = note.body.replace(
      '- **2026-01-01**: Entry number 1.',
      '- **2026-01-01**: Entry number 1.\n- a hand-written line with no date',
    );
    const out = curate(note, RESULT, { date: '2026-03-01' });
    expect(out.body).toContain('- a hand-written line with no date');
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run electron/__tests__/brain-curate.test.ts`
Expected: FAIL — `Failed to resolve import "../services/brain/curate"`.

- [ ] **Step 4: Implement `curate.ts`**

Create `electron/services/brain/curate.ts`:

```ts
import { appendUnique, parseSections, renderBody, type Sections } from './merge';
import { SECTION_ORDER } from './merge';
import type { ParsedNote } from './types';

/**
 * Curation: the one Brain pass that REMOVES (spec §1, §2).
 *
 * Pure, like `merge.ts`: no I/O, no model, no clock. Dates arrive as
 * parameters, because a function that reads its own clock turns its
 * idempotency test into a race against midnight.
 *
 * The load-bearing rule: THE MODEL NEVER CHOOSES WHAT TO DELETE. This module
 * picks the entries and computes their date range; the model is handed that
 * span and returns prose about it. So the operation that loses detail is a
 * pure function that can be tested exhaustively, and the operation that cannot
 * be tested — the model's judgement — can only add a sentence.
 */

/**
 * §10's numbers, inherited from Rowboat and NOT yet measured against a real
 * vault. `stats.ts` exists to say whether they are right; retune them from
 * what it reports rather than from taste.
 */
export const MIN_TIMELINE_ENTRIES = 8;
export const RETAIN_RECENT = 5;
export const COOLDOWN_DAYS = 7;
export const MAX_NOTES_PER_RUN = 8;

/**
 * What a curation run produces. Declared here rather than in `curation.ts` so
 * the pure fold never imports the model module; `curation.ts`'s zod schema
 * infers this same shape and a test pins them together.
 */
export interface CurationResult {
  /** Prose summarizing the collapsed span. */
  collapsed: string;
  /** Facts recurring across the span, worth promoting into Key facts. */
  promotedFacts: string[];
}

/** A Timeline bullet `merge()` wrote: `- **YYYY-MM-DD**: text`. */
const DATED_ENTRY = /^- \*\*(\d{4}-\d{2}-\d{2})\*\*/;

function isDated(line: string): boolean {
  return DATED_ENTRY.test(line);
}

function dateOf(line: string): string {
  return DATED_ENTRY.exec(line)?.[1] ?? '';
}

function timelineOf(note: ParsedNote): string[] | undefined {
  return parseSections(note.body).sections.get('Timeline');
}

/**
 * Whole days from `from` to `to`, both ISO dates.
 *
 * An unparseable input yields Infinity rather than NaN, so a hand-mangled
 * `curated_at` lets the note through instead of blocking curation on it
 * forever — a stuck note is a worse failure than an early re-curation.
 */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.floor((b - a) / 86_400_000);
}

/**
 * Four guards, all of which must hold. See spec §2.
 *
 * The shape guard is what excludes translated auto-memory notes: their bodies
 * are `## Summary` plus the original prose and carry no Timeline, so freeform
 * notes are never curated without needing to know they exist.
 */
export function qualifies(note: ParsedNote, today: string): boolean {
  const timeline = timelineOf(note);
  if (timeline === undefined) return false;
  if (timeline.filter(isDated).length < MIN_TIMELINE_ENTRIES) return false;

  const curatedAt = note.frontmatter.curated_at;
  if (curatedAt === undefined) return true;
  if (note.frontmatter.updated <= curatedAt) return false;
  return daysBetween(curatedAt, today) >= COOLDOWN_DAYS;
}

/**
 * The entries this fold would collapse: every dated one except the newest
 * `RETAIN_RECENT`.
 *
 * Exported so the prompt is built from exactly what the fold will remove. Two
 * independent spellings of "which entries" would eventually disagree, and the
 * model would then summarize a span that is not the span being deleted.
 */
export function collapsibleEntries(note: ParsedNote): string[] {
  const dated = (timelineOf(note) ?? []).filter(isDated);
  return dated.slice(0, Math.max(0, dated.length - RETAIN_RECENT));
}

/**
 * Model prose to one safe bullet-sized line.
 *
 * Headings are stripped and newlines flattened: either would end the bullet
 * and restructure the note, which is the failure the structured write path
 * exists to prevent.
 */
function flatten(prose: string): string {
  return prose
    .split('\n')
    .map((line) => line.replace(/^\s*#{1,6}\s+/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fold a curation result into a note.
 *
 * Only `Timeline` and `Key facts` are written — the sections `merge()` already
 * owns. `Summary`, `Connected to`, `Decisions`, `Open items` and
 * `Assistant notes` are carried through verbatim, so the invariant stays one
 * sentence: automated writes never touch human sections.
 */
export function curate(
  note: ParsedNote,
  result: CurationResult,
  opts: { date: string },
): ParsedNote {
  const parsed = parseSections(note.body);
  const title = parsed.title ?? '';

  const timeline = parsed.sections.get('Timeline') ?? [];
  const dated = timeline.filter(isDated);
  // Hand-written lines that are not dated bullets are never collapsed — this
  // pass may not delete what it cannot parse.
  const undated = timeline.filter((line) => !isDated(line) && line.trim() !== '');
  const cut = Math.max(0, dated.length - RETAIN_RECENT);
  const collapsing = dated.slice(0, cut);

  // Nothing to collapse: stamp and return. Reachable only by a caller that
  // skipped `qualifies`, and pinned by a test rather than left to chance.
  if (collapsing.length === 0) {
    return { frontmatter: { ...note.frontmatter, curated_at: opts.date }, body: note.body };
  }

  const first = dateOf(collapsing[0]);
  const last = dateOf(collapsing[collapsing.length - 1]);
  // The range is computed from the entries, never taken from the model.
  const span = first === last ? `**${first}**` : `**${first} – ${last}**`;
  const collapsed =
    `- ${span}: ${flatten(result.collapsed)} ` +
    `_(${String(collapsing.length)} entries collapsed)_`;

  const sections: Sections = new Map();
  for (const name of SECTION_ORDER) {
    sections.set(name, [...(parsed.sections.get(name) ?? [])]);
  }
  sections.set('Timeline', [collapsed, ...dated.slice(cut), ...undated]);
  sections.set(
    'Key facts',
    appendUnique(
      parsed.sections.get('Key facts') ?? [],
      result.promotedFacts.map((f) => `- ${flatten(f)}`),
    ),
  );

  return {
    frontmatter: { ...note.frontmatter, curated_at: opts.date },
    body: renderBody(title, sections),
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run electron/__tests__/brain-curate.test.ts electron/__tests__/brain-merge.test.ts`
Expected: PASS, both files. `brain-merge.test.ts` must stay green — Step 1 only added `export` keywords.

- [ ] **Step 6: Commit**

```bash
git add electron/services/brain/curate.ts electron/services/brain/merge.ts electron/__tests__/brain-curate.test.ts
git commit -m "feat(brain): the pure curation fold

The model never chooses what to delete: curate() picks the entries and
computes their date range, and the model supplies only prose about them.
Timeline and Key facts only — human sections are carried through verbatim."
```

---

## Task 2: `curation.ts` — the model side

**Files:**
- Create: `electron/services/brain/curation.ts`
- Modify: `electron/services/brain/extract.ts` (export `firstJsonObject`)
- Test: `electron/__tests__/brain-curation.test.ts`

**Interfaces:**
- Consumes: `CurationResult` from `./curate`; `firstJsonObject` from `./extract`; `createSummaryQueryRunner` from `../sessions/summary-query`.
- Produces:
  ```ts
  export const CURATION_MODEL = 'claude-opus-5';
  export class CurationParseError extends Error {}
  export interface CurationInput { title: string; noteType: string; entries: string[] }
  export function buildCurationPrompt(input: CurationInput): string;
  export function parseCuration(raw: string): CurationResult;
  export type Curator = (input: CurationInput, configDir: string) => Promise<CurationResult>;
  export function createCurator(deps?: { runQuery?: (o: { prompt: string; model: string; configDir: string }) => Promise<string> }): Curator;
  ```

- [ ] **Step 1: Export `firstJsonObject` from `extract.ts`**

In `electron/services/brain/extract.ts`, change the declaration at line 63 to add `export`, and extend its doc comment with one line:

```ts
/**
 * The first balanced `{...}` span in a string, or null.
 *
 * ... (existing comment unchanged) ...
 *
 * Exported for `curation.ts`, which parses a reply from the same CLI in the
 * same way. A second brace counter would be a second place to get string
 * escaping wrong.
 */
export function firstJsonObject(raw: string): string | null {
```

- [ ] **Step 2: Write the failing tests**

Create `electron/__tests__/brain-curation.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  CURATION_MODEL,
  CurationParseError,
  buildCurationPrompt,
  createCurator,
  parseCuration,
} from '../services/brain/curation';

const INPUT = {
  title: 'Widget',
  noteType: 'Subsystem',
  entries: [
    '- **2026-01-01**: Specified the flange.',
    '- **2026-01-04**: Revised the flange.',
  ],
};

describe('buildCurationPrompt', () => {
  it('states the note, the span and the entries verbatim', () => {
    const prompt = buildCurationPrompt(INPUT);
    expect(prompt).toContain('Widget');
    expect(prompt).toContain('Subsystem');
    expect(prompt).toContain('2026-01-01');
    expect(prompt).toContain('2026-01-04');
    expect(prompt).toContain('Specified the flange.');
  });

  it('tells the model it is summarizing, not choosing what to remove', () => {
    const prompt = buildCurationPrompt(INPUT);
    expect(prompt).toContain('already been selected');
  });

  it('asks for exactly the two fields, and nothing else', () => {
    const prompt = buildCurationPrompt(INPUT);
    expect(prompt).toContain('"collapsed"');
    expect(prompt).toContain('"promotedFacts"');
  });
});

describe('parseCuration', () => {
  it('accepts a fenced reply with prose around it', () => {
    const raw = 'Sure!\n```json\n{"collapsed":"Early work.","promotedFacts":["a"]}\n```\nDone.';
    expect(parseCuration(raw)).toEqual({ collapsed: 'Early work.', promotedFacts: ['a'] });
  });

  it('defaults promotedFacts to an empty array', () => {
    expect(parseCuration('{"collapsed":"x"}')).toEqual({ collapsed: 'x', promotedFacts: [] });
  });

  it('throws CurationParseError when there is no JSON object', () => {
    expect(() => parseCuration('I could not do that.')).toThrow(CurationParseError);
  });

  it('throws CurationParseError when collapsed is missing', () => {
    expect(() => parseCuration('{"promotedFacts":[]}')).toThrow(CurationParseError);
  });
});

describe('createCurator', () => {
  it('calls the pinned model with the account config dir', async () => {
    const runQuery = vi.fn().mockResolvedValue('{"collapsed":"ok","promotedFacts":[]}');
    const curator = createCurator({ runQuery });
    const out = await curator(INPUT, '/cfg');

    expect(out).toEqual({ collapsed: 'ok', promotedFacts: [] });
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery.mock.calls[0][0].model).toBe(CURATION_MODEL);
    expect(runQuery.mock.calls[0][0].configDir).toBe('/cfg');
  });

  it('is pinned to Opus, not to the extraction model', () => {
    expect(CURATION_MODEL).toBe('claude-opus-5');
  });

  it('retries exactly once on an unusable reply', async () => {
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce('nope')
      .mockResolvedValueOnce('{"collapsed":"second try","promotedFacts":[]}');
    const out = await createCurator({ runQuery })(INPUT, '/cfg');

    expect(out.collapsed).toBe('second try');
    expect(runQuery).toHaveBeenCalledTimes(2);
  });

  it('does not retry a transport failure', async () => {
    const runQuery = vi.fn().mockRejectedValue(new Error('spawn failed'));
    await expect(createCurator({ runQuery })(INPUT, '/cfg')).rejects.toThrow('spawn failed');
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  it('propagates a second bad reply rather than looping', async () => {
    const runQuery = vi.fn().mockResolvedValue('still nope');
    await expect(createCurator({ runQuery })(INPUT, '/cfg')).rejects.toThrow(CurationParseError);
    expect(runQuery).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `npx vitest run electron/__tests__/brain-curation.test.ts`
Expected: FAIL — `Failed to resolve import "../services/brain/curation"`.

- [ ] **Step 4: Implement `curation.ts`**

Create `electron/services/brain/curation.ts`:

```ts
import { z } from 'zod';
import { createSummaryQueryRunner } from '../sessions/summary-query';
import type { CurationResult } from './curate';
import { firstJsonObject } from './extract';

/**
 * The curation contract (spec §3). `extract.ts`'s twin: schema, prompt, pinned
 * model, retry-once runner.
 */

const CurationResultSchema = z.object({
  collapsed: z.string().trim().min(1),
  promotedFacts: z.array(z.string()).default([]),
});

/** Compile-time proof that the schema and the fold's input agree. */
type SchemaShape = z.infer<typeof CurationResultSchema>;
const _shapeCheck: (a: SchemaShape) => CurationResult = (a) => a;
void _shapeCheck;

export class CurationParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurationParseError';
  }
}

/**
 * Opus, pinned SEPARATELY from `EXTRACTION_MODEL` (spec §3).
 *
 * Volume is the entire reason extraction is not on Opus — backfill is ~142
 * sessions. Curation has no such volume: at most `MAX_NOTES_PER_RUN` notes per
 * run, behind a 7-day cooldown, on notes that have already accumulated. It is
 * a compression task where a subtle judgement error is durable, which is where
 * the better model earns its cost.
 *
 * Two tasks with different volume and different stakes get two constants. The
 * next reason to change one will not apply to the other.
 */
export const CURATION_MODEL = 'claude-opus-5';

/** What the model is shown. `entries` is exactly what the fold will remove. */
export interface CurationInput {
  title: string;
  noteType: string;
  entries: string[];
}

export function parseCuration(raw: string): CurationResult {
  const json = firstJsonObject(raw);
  if (json === null) {
    throw new CurationParseError(`no JSON object in reply: ${raw.slice(0, 200)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (err) {
    throw new CurationParseError(`reply is not valid JSON: ${(err as Error).message}`);
  }

  const result = CurationResultSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new CurationParseError(
      `curation failed validation at ${first.path.join('.') || '(root)'}: ${first.message}`,
    );
  }
  return result.data;
}

/**
 * The prompt.
 *
 * It states plainly that the entries have ALREADY been chosen. The model is
 * summarizing a span, not deciding what history to lose — telling it otherwise
 * would invite it to argue with a decision it has no say in, and a reply that
 * withholds prose for entries this fold is going to remove anyway would leave
 * the note worse off.
 */
export function buildCurationPrompt(input: CurationInput): string {
  return `You are compressing the history section of one note in an engineering
knowledge vault, so that retrieving the note costs less context.

Return ONLY a JSON object matching this shape, with no commentary:

{"collapsed":string,"promotedFacts":[string]}

Rules:
- \`collapsed\` is 1-3 sentences of plain prose covering the entries below as a
  whole. It replaces them. Write what a developer would still need in six
  months: what was decided, what changed, what it led to.
- \`promotedFacts\` are durable facts that recur across these entries and are
  worth keeping as standalone facts once the entries are gone. Return [] if
  there are none. Do not restate the prose.
- Write plain sentences. No Markdown headings, no bullets, no line breaks.
- These entries have already been selected for collapsing. Your job is to
  summarize them, not to choose which ones survive.

NOTE
${input.noteType}: ${input.title}

ENTRIES BEING COLLAPSED
${input.entries.join('\n')}`;
}

export type Curator = (input: CurationInput, configDir: string) => Promise<CurationResult>;

export interface CuratorDeps {
  /** Injected in tests. Defaults to the shared `claude -p` runner. */
  runQuery?: (opts: { prompt: string; model: string; configDir: string }) => Promise<string>;
}

export function createCurator(deps: CuratorDeps = {}): Curator {
  const runQuery = deps.runQuery ?? createSummaryQueryRunner();

  return async function curateWithModel(input, configDir) {
    const prompt = buildCurationPrompt(input);
    const reply = await runQuery({ prompt, model: CURATION_MODEL, configDir });
    try {
      return parseCuration(reply);
    } catch (err) {
      if (!(err instanceof CurationParseError)) throw err;
      // Exactly one retry, matching `createExtractor`. A transport error never
      // reaches here — `runQuery` rejects and that propagates unretried,
      // because a spawn or auth failure is not a bad answer and immediately
      // repeating it just fails twice.
      const second = await runQuery({ prompt, model: CURATION_MODEL, configDir });
      return parseCuration(second);
    }
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run electron/__tests__/brain-curation.test.ts electron/__tests__/brain-extract.test.ts`
Expected: PASS, both files.

- [ ] **Step 6: Commit**

```bash
git add electron/services/brain/curation.ts electron/services/brain/extract.ts electron/__tests__/brain-curation.test.ts
git commit -m "feat(brain): the curation prompt and its Opus pin

Pinned separately from EXTRACTION_MODEL: extraction is off Opus on volume
(~142 sessions), which curation does not have. Retry-once matches the
extractor; a transport error still propagates unretried."
```

---

## Task 3: the `process(entry)` seam in the queue

**Files:**
- Modify: `electron/services/brain/queue.ts`
- Modify: `electron/services/brain/registry.ts:469-477` (the one construction site)
- Test: `electron/__tests__/brain-queue.test.ts` (update two constructions, add two tests)

**Interfaces:**
- Produces:
  ```ts
  export const CURATION_SOURCE_ID = 'curation';
  export const BRAIN_CURATE_SETTING_KEY = 'brain.curate';
  export interface QueueWorkerDeps {
    store: BrainQueueStore;
    process(entry: QueueEntry): Promise<void>;
    hasActiveSession: HasActiveSession;
    isPaused(): boolean;
  }
  ```
  The old `indexSource(accountId, itemKey)` dependency is **removed**, not deprecated. No compatibility shim.

- [ ] **Step 1: Write the failing tests**

In `electron/__tests__/brain-queue.test.ts`, add this block inside the worker `describe`:

```ts
  it('hands the whole entry to process, so the worker need not know what an item is', async () => {
    store.enqueue(accountId, 'session', 'a');
    store.enqueue(accountId, CURATION_SOURCE_ID, 'Subsystems/Widget.md');
    const seen: { sourceId: string; itemKey: string }[] = [];
    const w = createBrainQueueWorker({
      store,
      process: async (entry) => {
        seen.push({ sourceId: entry.sourceId, itemKey: entry.itemKey });
      },
      hasActiveSession: () => false,
      isPaused: () => false,
    });

    await w.drain();

    expect(seen).toEqual([
      { sourceId: 'session', itemKey: 'a' },
      { sourceId: CURATION_SOURCE_ID, itemKey: 'Subsystems/Widget.md' },
    ]);
  });

  it('fails only the curation entry when process throws for it', async () => {
    store.enqueue(accountId, CURATION_SOURCE_ID, 'Subsystems/Bad.md');
    store.enqueue(accountId, 'session', 'good');
    const w = createBrainQueueWorker({
      store,
      process: async (entry) => {
        if (entry.sourceId === CURATION_SOURCE_ID) throw new Error('model said no');
      },
      hasActiveSession: () => false,
      isPaused: () => false,
    });

    await w.drain();

    const rows = store.list(accountId);
    expect(rows.find((r) => r.itemKey === 'Subsystems/Bad.md')?.status).toBe('failed');
    expect(rows.find((r) => r.itemKey === 'Subsystems/Bad.md')?.error).toBe('model said no');
    expect(rows.find((r) => r.itemKey === 'good')?.status).toBe('done');
  });
```

Add `CURATION_SOURCE_ID` to the existing import from `'../services/brain/queue'` at the top of the file.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run electron/__tests__/brain-queue.test.ts`
Expected: FAIL — `CURATION_SOURCE_ID` is not exported, and `process` is not a recognized dependency.

- [ ] **Step 3: Change the worker dependency**

In `electron/services/brain/queue.ts`, replace the `indexSource` member of `QueueWorkerDeps`:

```ts
export interface QueueWorkerDeps {
  store: BrainQueueStore;
  /**
   * Do one entry's work. Takes the WHOLE entry, not `(accountId, itemKey)`:
   * the queue now carries more than one kind of work — indexing a source and
   * curating a note — and a worker that destructured the pair would have to
   * know which was which. The registry owns that dispatch; this file does not
   * know what an item is.
   *
   * Resolves for a completed unit of work, including a skip. Rejects only for
   * a real failure, which is recorded against the entry and never blocks the
   * queue.
   */
  process(entry: QueueEntry): Promise<void>;
  hasActiveSession: HasActiveSession;
  isPaused(): boolean;
}
```

At `queue.ts:245`, replace the call:

```ts
          await deps.process(entry);
          deps.store.complete(entry.id);
```

Update the comment directly above it so it still describes what happens:

```ts
          // A skipped result — a gate rejection, an item unchanged since it was
          // last indexed, or a note that no longer qualifies for curation — is a
          // COMPLETED unit of work, not a failure. Recording it as failed would
          // fill the operational pane with red during entirely normal operation.
```

Add the two constants at the bottom of the file, beside the existing setting keys:

```ts
/**
 * The sentinel `source_id` for a curation row. It names no adapter — there is
 * no curation `BrainSource` — and exists so one queue can carry both kinds of
 * work. The registry dispatches on it; nothing else should match on it.
 */
export const CURATION_SOURCE_ID = 'curation';

/**
 * Curation on session close. Default `'false'`, for the same reason
 * auto-indexing is: it spends tokens unattended, and curation additionally
 * REWRITES existing notes. The user opts in once, after seeing real output.
 */
export const BRAIN_CURATE_SETTING_KEY = 'brain.curate';
```

- [ ] **Step 4: Update the two existing worker constructions in the test file**

`brain-queue.test.ts:201-208` becomes:

```ts
    const w = createBrainQueueWorker({
      store,
      process: async (entry) => {
        state.indexed.push(entry.itemKey);
        await state.result(entry.itemKey);
      },
      hasActiveSession: () => state.active,
      isPaused: () => state.paused,
    });
```

`brain-queue.test.ts:314-321` becomes:

```ts
    const w = createBrainQueueWorker({
      store,
      process: async () => {
        seen.push(wRef.current()?.itemKey ?? null);
      },
      hasActiveSession: () => false,
      isPaused: () => false,
    });
```

- [ ] **Step 5: Update the registry construction site**

`electron/services/brain/registry.ts:469-477` becomes:

```ts
  const queueWorker = createBrainQueueWorker({
    store: queueStore,
    // The dispatch. Routed through the service's own methods rather than
    // captured closures, so every drain gets the unchanged-item short-circuit,
    // the per-entity isolation and the re-qualification check that live there.
    process: async (entry) => {
      if (entry.sourceId === CURATION_SOURCE_ID) {
        await service.curateNote(entry.accountId, entry.itemKey);
        return;
      }
      await service.indexSource(entry.accountId, entry.itemKey);
    },
    hasActiveSession: opts.hasActiveSession ?? (() => false),
    isPaused: opts.isQueuePaused ?? (() => false),
  });
```

Add `CURATION_SOURCE_ID` to the existing `./queue` import at `registry.ts:19`. `service.curateNote` does not exist yet — that is Task 4, and `npm run check` will fail until then. That is expected and is why Steps 6 and 7 only run the queue suite.

- [ ] **Step 6: Run the queue tests**

Run: `npx vitest run electron/__tests__/brain-queue.test.ts`
Expected: PASS. (`npm run check` will still fail on `service.curateNote`; do not fix that here.)

- [ ] **Step 7: Commit**

```bash
git add electron/services/brain/queue.ts electron/services/brain/registry.ts electron/__tests__/brain-queue.test.ts
git commit -m "refactor(brain): the queue worker takes process(entry), not indexSource

One queue now carries two kinds of work. The worker stops knowing what an
item is; the registry owns the dispatch. No shim — the old dependency is
gone and every call site moved with it."
```

---

## Task 4: `curateNote` and `enqueueCuration` on the registry

**Files:**
- Modify: `electron/services/brain/registry.ts`
- Test: `electron/__tests__/brain-curation-registry.test.ts` (create)

**Interfaces:**
- Consumes: `qualifies`, `collapsibleEntries`, `curate`, `MAX_NOTES_PER_RUN` from `./curate`; `Curator` from `./curation`; `CURATION_SOURCE_ID` from `./queue`.
- Produces, on `BrainService`:
  ```ts
  export interface CurateResult { notePath: string; skipped: boolean; reason: string }
  curateNote(accountId: number, relPath: string): Promise<CurateResult>;
  enqueueCuration(accountId: number): number;
  ```
  And on `BrainServiceOptions`: `curator?: Curator`.

  `enqueueCuration` is synchronous — it reads the vault, which is synchronous — unlike `backfill`, which awaits `discover()`.

- [ ] **Step 1: Write the failing tests**

Create `electron/__tests__/brain-curation-registry.test.ts`. Model the harness on `brain-registry.test.ts`: `createDatabase(':memory:')`, a stub `execGit`, a temp vault directory, and an accounts stub.

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createBrainService, type BrainService } from '../services/brain/registry';
import { CURATION_SOURCE_ID } from '../services/brain/queue';
import { MAX_NOTES_PER_RUN, MIN_TIMELINE_ENTRIES } from '../services/brain/curate';
import type { AccountsService } from '../services/accounts';
import type { ParsedNote } from '../services/brain/types';

/** Never spawns git: cleanup must not race an untracked child process. */
const execGit = () => Promise.resolve({ stdout: '', stderr: '' });

function accountsStub(id: number, configDir: string): AccountsService {
  return {
    listAccounts: () => [{ id, name: 'personal', config_dir: configDir }],
  } as unknown as AccountsService;
}

function noteWith(entries: number): ParsedNote {
  const lines = Array.from({ length: entries }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    return `- **2026-01-${day}**: Entry ${String(i + 1)}.`;
  });
  return {
    frontmatter: {
      type: 'Subsystem',
      aliases: [],
      keywords: [],
      created: '2026-01-01',
      updated: '2026-02-01',
      sources: ['session:a'],
    },
    body: [
      '# Widget',
      '',
      '## Summary',
      'A widget.',
      '',
      '## Connected to',
      '',
      '## Timeline',
      ...lines,
      '',
      '## Decisions',
      '',
      '## Key facts',
      '',
      '## Open items',
      '- Ask Greg.',
      '',
      '## Assistant notes',
      '',
    ].join('\n'),
  };
}

describe('curation on the registry', () => {
  let db: Database;
  let root: string;
  let brain: BrainService;
  let curator: ReturnType<typeof vi.fn>;
  const accountId = 1;

  beforeEach(() => {
    db = createDatabase(':memory:');
    root = mkdtempSync(join(tmpdir(), 'brain-curation-'));
    curator = vi.fn().mockResolvedValue({ collapsed: 'Early work.', promotedFacts: ['A fact.'] });
    brain = createBrainService(db, {
      execGit,
      curator: curator as never,
      accounts: accountsStub(accountId, '/cfg'),
    });
    brain.setVaultPath(accountId, root);
  });

  afterEach(() => {
    brain.closeAll();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('curates a qualifying note and commits as Curation', async () => {
    brain.writeNote(accountId, 'Subsystems/Widget.md', noteWith(12), 'seed');

    const result = await brain.curateNote(accountId, 'Subsystems/Widget.md');

    expect(result.skipped).toBe(false);
    expect(curator).toHaveBeenCalledTimes(1);
    const note = brain.open(accountId)?.vault.readNote('Subsystems/Widget.md');
    expect(note?.body).toContain('entries collapsed)_');
    expect(note?.body).toContain('- A fact.');
    expect(note?.frontmatter.curated_at).toBeDefined();
    // The human section survives a model-driven rewrite.
    expect(note?.body).toContain('- Ask Greg.');
  });

  it('is handed exactly the entries the fold will collapse', async () => {
    brain.writeNote(accountId, 'Subsystems/Widget.md', noteWith(12), 'seed');
    await brain.curateNote(accountId, 'Subsystems/Widget.md');

    const input = curator.mock.calls[0][0] as { entries: string[]; title: string };
    expect(input.title).toBe('Widget');
    expect(input.entries).toHaveLength(7);
    expect(input.entries[0]).toContain('Entry 1.');
    expect(input.entries[6]).toContain('Entry 7.');
  });

  it('runs under the owning account config dir', async () => {
    brain.writeNote(accountId, 'Subsystems/Widget.md', noteWith(12), 'seed');
    await brain.curateNote(accountId, 'Subsystems/Widget.md');
    expect(curator.mock.calls[0][1]).toBe('/cfg');
  });

  it('spends nothing on a note that no longer qualifies', async () => {
    brain.writeNote(accountId, 'Subsystems/Short.md', noteWith(3), 'seed');

    const result = await brain.curateNote(accountId, 'Subsystems/Short.md');

    expect(result.skipped).toBe(true);
    expect(curator).not.toHaveBeenCalled();
  });

  it('spends nothing on a note that disappeared between enqueue and claim', async () => {
    const result = await brain.curateNote(accountId, 'Subsystems/Gone.md');
    expect(result.skipped).toBe(true);
    expect(curator).not.toHaveBeenCalled();
  });

  it('leaves the note untouched when the model reply is unusable', async () => {
    brain.writeNote(accountId, 'Subsystems/Widget.md', noteWith(12), 'seed');
    const before = brain.open(accountId)?.vault.readNote('Subsystems/Widget.md');
    curator.mockRejectedValue(new Error('curation failed validation'));

    await expect(brain.curateNote(accountId, 'Subsystems/Widget.md')).rejects.toThrow(
      'curation failed validation',
    );

    const after = brain.open(accountId)?.vault.readNote('Subsystems/Widget.md');
    expect(after?.body).toBe(before?.body);
    expect(after?.frontmatter.curated_at).toBeUndefined();
  });

  it('enqueues only qualifying notes, longest first', () => {
    brain.writeNote(accountId, 'Subsystems/Short.md', noteWith(3), 'seed');
    brain.writeNote(accountId, 'Subsystems/Long.md', noteWith(20), 'seed');
    brain.writeNote(accountId, 'Subsystems/Medium.md', noteWith(MIN_TIMELINE_ENTRIES), 'seed');

    const queued = brain.enqueueCuration(accountId);

    expect(queued).toBe(2);
    const rows = brain.queueList(accountId).filter((r) => r.sourceId === CURATION_SOURCE_ID);
    expect(rows.map((r) => r.itemKey).reverse()).toEqual([
      'Subsystems/Long.md',
      'Subsystems/Medium.md',
    ]);
  });

  it('caps one run at MAX_NOTES_PER_RUN', () => {
    for (let i = 0; i < MAX_NOTES_PER_RUN + 3; i += 1) {
      brain.writeNote(accountId, `Subsystems/N${String(i)}.md`, noteWith(12), 'seed');
    }
    expect(brain.enqueueCuration(accountId)).toBe(MAX_NOTES_PER_RUN);
  });

  it('returns 0 when no vault is configured', () => {
    brain.clearVaultPath(accountId);
    expect(brain.enqueueCuration(accountId)).toBe(0);
  });

  it('drains a curation row through the worker', async () => {
    brain.writeNote(accountId, 'Subsystems/Widget.md', noteWith(12), 'seed');
    brain.enqueueCuration(accountId);

    await brain.drainQueue();

    expect(curator).toHaveBeenCalledTimes(1);
    expect(brain.queueCounts(accountId).done).toBe(1);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run electron/__tests__/brain-curation-registry.test.ts`
Expected: FAIL — `brain.curateNote is not a function`.

- [ ] **Step 3: Add the option and the imports**

In `registry.ts`, add to the imports:

```ts
import { MAX_NOTES_PER_RUN, collapsibleEntries, curate, qualifies } from './curate';
import type { Curator } from './curation';
```

Add to `BrainServiceOptions`, beside `extractor`:

```ts
  /**
   * Compresses an accumulated note. Absent means curation is unavailable —
   * `curateNote` throws rather than silently no-opping, the same rule
   * `extractor` follows.
   */
  curator?: Curator;
```

Add near the other result types:

```ts
/** What one curation run did to one note. */
export interface CurateResult {
  notePath: string;
  /** True when nothing was spent: the note vanished, or stopped qualifying. */
  skipped: boolean;
  reason: string;
}
```

Add to the `BrainService` interface, after `indexSource`:

```ts
  /**
   * Compress one note's accumulated Timeline. The second method here that
   * spends tokens.
   *
   * Re-checks `qualifies` BEFORE spending: a note can change between enqueue
   * and claim, and Plan 4a's most expensive bug was `indexSource` ignoring
   * exactly this class of check while every unit test passed.
   *
   * Resolves with `skipped` for a note that vanished or stopped qualifying —
   * both are completed units of work. Rejects when the model reply is
   * unusable, so the queue records a failure and the note is left untouched.
   */
  curateNote(accountId: number, relPath: string): Promise<CurateResult>;
  /**
   * Queue the notes most worth compressing, longest Timeline first, capped at
   * `MAX_NOTES_PER_RUN`. Returns how many were queued. Synchronous: reading a
   * vault is, unlike `backfill`'s `discover()`.
   */
  enqueueCuration(accountId: number): number;
```

- [ ] **Step 4: Implement both methods**

Add a helper near the top of `createBrainService`, beside the other module-level helpers:

```ts
/** Today as an ISO date. The one clock read in the curation path; every
 *  function it feeds takes the date as a parameter and stays pure. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
```

Add both methods to the `service` object, after `indexSource`:

```ts
    async curateNote(accountId: number, relPath: string): Promise<CurateResult> {
      requireAccountId(accountId);
      if (!opts.curator) throw new Error('brain: no curator configured');
      if (!opts.accounts) throw new Error('brain: no accounts service configured');

      const handle = requireHandle(accountId);

      let note;
      try {
        note = handle.vault.readNote(relPath);
      } catch {
        // Deleted, or unparseable after a hand edit, between enqueue and claim.
        // A completed unit of work, not a failure — see the queue's skip rule.
        return { notePath: relPath, skipped: true, reason: 'note is missing or unreadable' };
      }

      const today = todayIso();
      // Before the token, never after. The note may have been curated or
      // shortened since it was queued.
      if (!qualifies(note, today)) {
        return { notePath: relPath, skipped: true, reason: 'no longer qualifies for curation' };
      }

      const account = opts.accounts.listAccounts().find((a) => a.id === accountId);
      if (!account) {
        // No silent fallback to another account's config dir — that would push
        // this account's content through the wrong subscription (spec §4).
        return { notePath: relPath, skipped: true, reason: 'no account for this note' };
      }

      const entries = collapsibleEntries(note);
      // Deliberately unguarded: a rejection here propagates to the worker,
      // which records the failure against the queue entry. The note is not
      // written, so a failed curation costs tokens and not history.
      const result = await opts.curator(
        { title: handle.vault.noteTitle(relPath), noteType: note.frontmatter.type, entries },
        account.config_dir,
      );

      const curated = curate(note, result, { date: today });
      handle.vault.writeNote(relPath, curated);
      handle.index.upsert(relPath, handle.vault.noteTitle(relPath), curated);
      commitAndRecord(handle, 'Curation');

      return {
        notePath: relPath,
        skipped: false,
        reason: `${String(entries.length)} entries collapsed`,
      };
    },

    enqueueCuration(accountId: number): number {
      requireAccountId(accountId);
      const handle = readPath(accountId) === null ? null : requireHandle(accountId);
      if (!handle) return 0;

      const today = todayIso();
      const candidates: { relPath: string; length: number }[] = [];
      for (const relPath of handle.vault.listNotes()) {
        let note;
        try {
          note = handle.vault.readNote(relPath);
        } catch {
          // One unreadable note must not cost the whole run.
          continue;
        }
        if (!qualifies(note, today)) continue;
        candidates.push({ relPath, length: collapsibleEntries(note).length });
      }

      // Worst offenders first: the longest Timeline is where compression buys
      // the most context back. Ties break on path so a run is deterministic.
      candidates.sort((a, b) => b.length - a.length || a.relPath.localeCompare(b.relPath));

      const chosen = candidates.slice(0, MAX_NOTES_PER_RUN);
      for (const c of chosen) queueStore.enqueue(accountId, CURATION_SOURCE_ID, c.relPath);
      return chosen.length;
    },
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run electron/__tests__/brain-curation-registry.test.ts electron/__tests__/brain-registry.test.ts electron/__tests__/brain-queue.test.ts`
Expected: PASS, all three.

- [ ] **Step 6: Typecheck**

Run: `npm run check`
Expected: clean. Task 3's forward reference to `service.curateNote` now resolves.

- [ ] **Step 7: Commit**

```bash
git add electron/services/brain/registry.ts electron/__tests__/brain-curation-registry.test.ts
git commit -m "feat(brain): curateNote and enqueueCuration

curateNote re-checks qualifies before spending — Plan 4a's lesson, applied
to the second path that spends tokens. An unusable model reply rejects,
so the queue records it and the note is left exactly as it was."
```

---

## Task 5: vault statistics

**Files:**
- Create: `electron/services/brain/stats.ts`
- Modify: `electron/services/brain/registry.ts` (add `stats`)
- Test: `electron/__tests__/brain-stats.test.ts` (create), plus one registry test appended to `brain-curation-registry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const BYTES_PER_TOKEN = 4;
  export interface VaultStats {
    noteCount: number;
    totalBytes: number;
    byType: Record<string, number>;
    medianBytes: number;
    largestBytes: number;
    largestNote: string | null;
    estimatedTokens: { median: number; largest: number; vault: number };
    timelineBuckets: { label: string; count: number }[];
    qualifyingCount: number;
    recentlyCurated: { relPath: string; curatedAt: string }[];
  }
  export function computeVaultStats(
    notes: { relPath: string; note: ParsedNote }[],
    today: string,
  ): VaultStats;
  ```
  Pure: the registry does the reading, this does the arithmetic. Byte size is `Buffer.byteLength(serializeNote(note))` — the canonical serialization, which is what is on disk for every machine-written note.

- [ ] **Step 1: Write the failing tests**

Create `electron/__tests__/brain-stats.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BYTES_PER_TOKEN, computeVaultStats } from '../services/brain/stats';
import type { ParsedNote } from '../services/brain/types';

function note(entries: number, extra: Partial<ParsedNote['frontmatter']> = {}): ParsedNote {
  const lines = Array.from({ length: entries }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    return `- **2026-01-${day}**: Entry ${String(i + 1)}.`;
  });
  return {
    frontmatter: {
      type: 'Subsystem',
      aliases: [],
      keywords: [],
      created: '2026-01-01',
      updated: '2026-02-01',
      sources: [],
      ...extra,
    },
    body: ['# N', '', '## Timeline', ...lines, ''].join('\n'),
  };
}

describe('computeVaultStats', () => {
  it('reports zeroes for an empty vault without dividing by zero', () => {
    const s = computeVaultStats([], '2026-03-01');
    expect(s.noteCount).toBe(0);
    expect(s.totalBytes).toBe(0);
    expect(s.medianBytes).toBe(0);
    expect(s.largestNote).toBeNull();
    expect(s.estimatedTokens.vault).toBe(0);
  });

  it('counts notes by type', () => {
    const s = computeVaultStats(
      [
        { relPath: 'Subsystems/A.md', note: note(1) },
        { relPath: 'Projects/B.md', note: note(1, { type: 'Project' }) },
        { relPath: 'Notes/C.md', note: note(1, { type: 'Note' }) },
      ],
      '2026-03-01',
    );
    expect(s.noteCount).toBe(3);
    expect(s.byType.Subsystem).toBe(1);
    expect(s.byType.Project).toBe(1);
    expect(s.byType.Note).toBe(1);
  });

  it('names the largest note and estimates its tokens', () => {
    const s = computeVaultStats(
      [
        { relPath: 'Subsystems/Small.md', note: note(1) },
        { relPath: 'Subsystems/Big.md', note: note(40) },
      ],
      '2026-03-01',
    );
    expect(s.largestNote).toBe('Subsystems/Big.md');
    expect(s.estimatedTokens.largest).toBe(Math.round(s.largestBytes / BYTES_PER_TOKEN));
  });

  it('buckets notes by Timeline length', () => {
    const s = computeVaultStats(
      [
        { relPath: 'a.md', note: note(0) },
        { relPath: 'b.md', note: note(2) },
        { relPath: 'c.md', note: note(5) },
        { relPath: 'd.md', note: note(10) },
        { relPath: 'e.md', note: note(30) },
      ],
      '2026-03-01',
    );
    expect(s.timelineBuckets).toEqual([
      { label: 'none', count: 1 },
      { label: '1–3', count: 1 },
      { label: '4–7', count: 1 },
      { label: '8–15', count: 1 },
      { label: '16+', count: 1 },
    ]);
  });

  it('counts how many notes qualify right now', () => {
    const s = computeVaultStats(
      [
        { relPath: 'a.md', note: note(3) },
        { relPath: 'b.md', note: note(12) },
        { relPath: 'c.md', note: note(12, { curated_at: '2026-02-28', updated: '2026-02-01' }) },
      ],
      '2026-03-01',
    );
    // Only b: a is too short, c has not changed since it was curated.
    expect(s.qualifyingCount).toBe(1);
  });

  it('lists recently curated notes, newest first', () => {
    const s = computeVaultStats(
      [
        { relPath: 'a.md', note: note(1, { curated_at: '2026-02-01' }) },
        { relPath: 'b.md', note: note(1) },
        { relPath: 'c.md', note: note(1, { curated_at: '2026-02-20' }) },
      ],
      '2026-03-01',
    );
    expect(s.recentlyCurated).toEqual([
      { relPath: 'c.md', curatedAt: '2026-02-20' },
      { relPath: 'a.md', curatedAt: '2026-02-01' },
    ]);
  });

  it('takes the median as the middle note by size', () => {
    const s = computeVaultStats(
      [
        { relPath: 'a.md', note: note(1) },
        { relPath: 'b.md', note: note(10) },
        { relPath: 'c.md', note: note(40) },
      ],
      '2026-03-01',
    );
    expect(s.medianBytes).toBeGreaterThan(0);
    expect(s.medianBytes).toBeLessThan(s.largestBytes);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run electron/__tests__/brain-stats.test.ts`
Expected: FAIL — cannot resolve `../services/brain/stats`.

- [ ] **Step 3: Implement `stats.ts`**

Create `electron/services/brain/stats.ts`:

```ts
import { qualifies } from './curate';
import { serializeNote } from './frontmatter';
import type { ParsedNote } from './types';

/**
 * What the Brain costs, and whether curation is firing at the right time
 * (spec §5).
 *
 * Pure: the registry does the reading, this does the arithmetic. The
 * threshold in `curate.ts` was inherited from Rowboat and never measured;
 * `qualifyingCount` and `timelineBuckets` are what replace that inheritance
 * with an observation.
 */

/**
 * Rough characters per token. This is a RATIO, not a tokenizer — the UI must
 * label every figure derived from it as an estimate, because presenting it as
 * exact would be a claim the number cannot support.
 */
export const BYTES_PER_TOKEN = 4;

const DATED_ENTRY = /^- \*\*\d{4}-\d{2}-\d{2}\*\*/;

export interface VaultStats {
  noteCount: number;
  totalBytes: number;
  /** Note type → count. Keys are `NoteType` values. */
  byType: Record<string, number>;
  medianBytes: number;
  largestBytes: number;
  largestNote: string | null;
  /** Every figure here is derived from BYTES_PER_TOKEN. Label as estimated. */
  estimatedTokens: { median: number; largest: number; vault: number };
  timelineBuckets: { label: string; count: number }[];
  qualifyingCount: number;
  recentlyCurated: { relPath: string; curatedAt: string }[];
}

/** How many curated notes to name. Enough to spot a bad run, not a log. */
const RECENT_LIMIT = 10;

function timelineLength(note: ParsedNote): number {
  let inTimeline = false;
  let count = 0;
  for (const line of note.body.split('\n')) {
    if (line.startsWith('## ')) {
      inTimeline = line.slice(3).trim() === 'Timeline';
      continue;
    }
    if (inTimeline && DATED_ENTRY.test(line)) count += 1;
  }
  return count;
}

function bucketOf(length: number): string {
  if (length === 0) return 'none';
  if (length <= 3) return '1–3';
  if (length <= 7) return '4–7';
  if (length <= 15) return '8–15';
  return '16+';
}

const BUCKET_ORDER = ['none', '1–3', '4–7', '8–15', '16+'];

export function computeVaultStats(
  notes: { relPath: string; note: ParsedNote }[],
  today: string,
): VaultStats {
  const byType: Record<string, number> = {};
  const buckets = new Map<string, number>(BUCKET_ORDER.map((b) => [b, 0]));
  const sizes: number[] = [];
  const curated: { relPath: string; curatedAt: string }[] = [];

  let totalBytes = 0;
  let largestBytes = 0;
  let largestNote: string | null = null;
  let qualifyingCount = 0;

  for (const { relPath, note } of notes) {
    const bytes = Buffer.byteLength(serializeNote(note), 'utf8');
    sizes.push(bytes);
    totalBytes += bytes;
    if (bytes > largestBytes) {
      largestBytes = bytes;
      largestNote = relPath;
    }

    byType[note.frontmatter.type] = (byType[note.frontmatter.type] ?? 0) + 1;

    const bucket = bucketOf(timelineLength(note));
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);

    if (qualifies(note, today)) qualifyingCount += 1;
    if (note.frontmatter.curated_at !== undefined) {
      curated.push({ relPath, curatedAt: note.frontmatter.curated_at });
    }
  }

  sizes.sort((a, b) => a - b);
  const medianBytes = sizes.length === 0 ? 0 : sizes[Math.floor((sizes.length - 1) / 2)];

  curated.sort((a, b) => b.curatedAt.localeCompare(a.curatedAt) || a.relPath.localeCompare(b.relPath));

  return {
    noteCount: notes.length,
    totalBytes,
    byType,
    medianBytes,
    largestBytes,
    largestNote,
    estimatedTokens: {
      median: Math.round(medianBytes / BYTES_PER_TOKEN),
      largest: Math.round(largestBytes / BYTES_PER_TOKEN),
      vault: Math.round(totalBytes / BYTES_PER_TOKEN),
    },
    timelineBuckets: BUCKET_ORDER.map((label) => ({ label, count: buckets.get(label) ?? 0 })),
    qualifyingCount,
    recentlyCurated: curated.slice(0, RECENT_LIMIT),
  };
}
```

- [ ] **Step 4: Run the stats tests**

Run: `npx vitest run electron/__tests__/brain-stats.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `stats()` to the registry**

Add to the `BrainService` interface:

```ts
  /** Vault size, context cost and Timeline distribution. Zeroes when
   *  unconfigured — a stats panel must render rather than throw. */
  stats(accountId: number): VaultStats;
```

Import at the top of `registry.ts`:

```ts
import { computeVaultStats, type VaultStats } from './stats';
```

Add the method to the `service` object:

```ts
    stats(accountId: number): VaultStats {
      requireAccountId(accountId);
      const handle = readPath(accountId) === null ? null : requireHandle(accountId);
      if (!handle) return computeVaultStats([], todayIso());

      const notes: { relPath: string; note: ParsedNote }[] = [];
      for (const relPath of handle.vault.listNotes()) {
        try {
          notes.push({ relPath, note: handle.vault.readNote(relPath) });
        } catch {
          // One unreadable note must not cost the whole reading.
        }
      }
      return computeVaultStats(notes, todayIso());
    },
```

- [ ] **Step 6: Add the registry-level test**

Append to `electron/__tests__/brain-curation-registry.test.ts`, inside the same `describe`:

```ts
  it('reports stats over the real vault, and zeroes when unconfigured', () => {
    brain.writeNote(accountId, 'Subsystems/Widget.md', noteWith(12), 'seed');
    brain.writeNote(accountId, 'Subsystems/Short.md', noteWith(2), 'seed');

    const stats = brain.stats(accountId);
    expect(stats.noteCount).toBe(2);
    expect(stats.qualifyingCount).toBe(1);
    expect(stats.totalBytes).toBeGreaterThan(0);

    brain.clearVaultPath(accountId);
    expect(brain.stats(accountId).noteCount).toBe(0);
  });
```

- [ ] **Step 7: Run both suites**

Run: `npx vitest run electron/__tests__/brain-stats.test.ts electron/__tests__/brain-curation-registry.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add electron/services/brain/stats.ts electron/services/brain/registry.ts electron/__tests__/brain-stats.test.ts electron/__tests__/brain-curation-registry.test.ts
git commit -m "feat(brain): vault statistics

qualifyingCount and the Timeline histogram are what replace the inherited
threshold with a measurement. Token figures are a bytes/4 ratio and are
labelled estimated wherever they surface."
```

---

## Task 6: IPC surface

**Files:**
- Modify: `electron/ipc/channels.ts`, `electron/ipc/brain-handlers.ts`, `src/lib/api.ts`
- Test: `electron/__tests__/brain-ipc.test.ts` (extend)

**Interfaces:**
- Consumes: `curateNote`, `enqueueCuration`, `stats` from Tasks 4 and 5.
- Produces: channels `brain_curate_note`, `brain_enqueue_curation`, `brain_stats`; renderer methods `api.brainCurateNote`, `api.brainEnqueueCuration`, `api.brainStats`; renderer type `BrainVaultStats`.

- [ ] **Step 1: Write the failing tests**

Add to `electron/__tests__/brain-ipc.test.ts`, following the existing fake-service pattern in that file:

```ts
  it('brain_curate_note throws when the service is unavailable', async () => {
    const handlers = createBrainHandlers(undefined);
    await expect(handlers.brain_curate_note({}, { accountId: 1, notePath: 'a.md' })).rejects.toThrow(
      'brain service unavailable',
    );
  });

  it('brain_enqueue_curation throws when the service is unavailable', async () => {
    const handlers = createBrainHandlers(undefined);
    await expect(handlers.brain_enqueue_curation({}, { accountId: 1 })).rejects.toThrow(
      'brain service unavailable',
    );
  });

  it('brain_stats degrades to an empty reading rather than throwing', async () => {
    const handlers = createBrainHandlers(undefined);
    const stats = (await handlers.brain_stats({}, { accountId: 1 })) as { noteCount: number };
    expect(stats.noteCount).toBe(0);
  });

  it('brain_curate_note accepts snake_case note_path', async () => {
    const curateNote = vi.fn().mockResolvedValue({ notePath: 'a.md', skipped: false, reason: 'ok' });
    const handlers = createBrainHandlers({ curateNote } as never);
    await handlers.brain_curate_note({}, { account_id: 3, note_path: 'a.md' });
    expect(curateNote).toHaveBeenCalledWith(3, 'a.md');
  });
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run electron/__tests__/brain-ipc.test.ts`
Expected: FAIL — `handlers.brain_curate_note is not a function`.

- [ ] **Step 3: Add the three channels**

In `electron/ipc/channels.ts`, add after `'brain_enqueue_project_sources'`:

```ts
  'brain_curate_note',
  'brain_enqueue_curation',
  'brain_stats',
```

- [ ] **Step 4: Add the three handlers**

In `electron/ipc/brain-handlers.ts`, add to the returned map:

```ts
    async brain_curate_note(_event, params = {}) {
      // Spends tokens, like brain_index_source: a null result while the
      // service is missing would report a curation that never happened.
      if (!brain) throw new Error('brain service unavailable');
      return brain.curateNote(
        requireAccountId(params),
        requireString(params, 'notePath', 'note_path'),
      );
    },

    async brain_enqueue_curation(_event, params = {}) {
      // A write that queues token-spending work, like brain_backfill.
      if (!brain) throw new Error('brain service unavailable');
      return brain.enqueueCuration(requireAccountId(params));
    },

    async brain_stats(_event, params = {}) {
      const accountId = requireAccountId(params);
      // A read: degrades so the stats panel renders truthful zeroes rather
      // than an error when the service failed to construct.
      if (!brain) return emptyStats();
      return brain.stats(accountId);
    },
```

And add the helper beside `unconfiguredStatus`:

```ts
/**
 * What `stats()` would report for an account with no vault. Mirrors
 * `computeVaultStats([], …)` — kept in shape by `brain-ipc.test.ts` rather
 * than by importing the service into the handler layer.
 */
function emptyStats(): VaultStats {
  return {
    noteCount: 0,
    totalBytes: 0,
    byType: {},
    medianBytes: 0,
    largestBytes: 0,
    largestNote: null,
    estimatedTokens: { median: 0, largest: 0, vault: 0 },
    timelineBuckets: [
      { label: 'none', count: 0 },
      { label: '1–3', count: 0 },
      { label: '4–7', count: 0 },
      { label: '8–15', count: 0 },
      { label: '16+', count: 0 },
    ],
    qualifyingCount: 0,
    recentlyCurated: [],
  };
}
```

Import the type: `import type { VaultStats } from '../services/brain/stats';`

- [ ] **Step 5: Add the renderer API**

In `src/lib/api.ts`, add the mirrored type beside the other Brain mirrors (around line 1126):

```ts
/** Mirrors the backend `VaultStats` in electron/services/brain/stats.ts. */
export interface BrainVaultStats {
  noteCount: number;
  totalBytes: number;
  byType: Record<string, number>;
  medianBytes: number;
  largestBytes: number;
  largestNote: string | null;
  /** Derived from a bytes/4 ratio. Always label these as estimates in the UI. */
  estimatedTokens: { median: number; largest: number; vault: number };
  timelineBuckets: { label: string; count: number }[];
  qualifyingCount: number;
  recentlyCurated: { relPath: string; curatedAt: string }[];
}

/** Mirrors the backend `CurateResult` in electron/services/brain/registry.ts. */
export interface BrainCurateResult {
  notePath: string;
  skipped: boolean;
  reason: string;
}
```

And the three methods beside `brainBackfill`:

```ts
  async brainCurateNote(accountId: number, notePath: string): Promise<BrainCurateResult> {
    return apiCall<BrainCurateResult>('brain_curate_note', { accountId, notePath });
  },

  async brainEnqueueCuration(accountId: number): Promise<number> {
    return apiCall<number>('brain_enqueue_curation', { accountId });
  },

  async brainStats(accountId: number): Promise<BrainVaultStats> {
    return apiCall<BrainVaultStats>('brain_stats', { accountId });
  },
```

- [ ] **Step 6: Run the IPC tests and the channel contract**

Run: `npx vitest run electron/__tests__/brain-ipc.test.ts electron/__tests__/ipc-channel-contract.test.ts`
Expected: PASS. The contract test is what catches a channel with no handler, or a handler with no channel.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run check`
Expected: clean.

```bash
git add electron/ipc/channels.ts electron/ipc/brain-handlers.ts src/lib/api.ts electron/__tests__/brain-ipc.test.ts
git commit -m "feat(brain): IPC for curation and vault stats

Two token-spending writes that throw when the service is missing, and one
read that degrades to zeroes so the stats panel always renders."
```

---

## Task 7: the Brain tab surfaces

**Files:**
- Create: `src/components/brain/BrainStatsPanel.tsx`
- Modify: `src/components/brain/BrainQueuePanel.tsx`, `src/components/brain/BrainTab.tsx`

**Interfaces:**
- Consumes: `api.brainStats`, `api.brainEnqueueCuration`, `BrainVaultStats` from Task 6.
- Produces: `<BrainStatsPanel accountId={…} nonce={…} onSelect={…} />`.

**Note on §6.** The spec calls for "a recently-curated filter in the note list". It ships here as a recently-curated *list inside the stats panel* instead. The reason is concrete: a filter in `BrainNoteList` would need `curated_at` for every note, which the renderer only has after reading every note over IPC — the backend already computes it in one pass for the stats panel. Same information, one read instead of N.

- [ ] **Step 1: Create the stats panel**

Create `src/components/brain/BrainStatsPanel.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import { api, type BrainVaultStats } from '@/lib/api';

/**
 * What the Brain costs, and whether curation is firing at the right time.
 *
 * The threshold in electron/services/brain/curate.ts was inherited from
 * Rowboat and never measured. `qualifyingCount` and the Timeline histogram are
 * what turn it into an observation: 0 means the threshold is theatre, 40 means
 * it is too loose.
 */
const EMPTY: BrainVaultStats = {
  noteCount: 0,
  totalBytes: 0,
  byType: {},
  medianBytes: 0,
  largestBytes: 0,
  largestNote: null,
  estimatedTokens: { median: 0, largest: 0, vault: 0 },
  timelineBuckets: [],
  qualifyingCount: 0,
  recentlyCurated: [],
};

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function tokens(n: number): string {
  return n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${String(n)}`;
}

export const BrainStatsPanel: React.FC<{
  accountId: number | null;
  /** Bumped by the queue panel after a run, so the figures do not go stale. */
  nonce?: number;
  onSelect?: (notePath: string) => void;
}> = ({ accountId, nonce = 0, onSelect }) => {
  const [stats, setStats] = useState<BrainVaultStats>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (accountId === null) {
      setStats(EMPTY);
      return;
    }
    let cancelled = false;
    api
      .brainStats(accountId)
      .then((s) => { if (!cancelled) { setStats(s); setError(null); } })
      .catch((err: Error) => {
        // Zeroes would read as "an empty vault", which is a different and much
        // more alarming claim than "the reading failed".
        if (!cancelled) setError(err.message);
      });
    return () => { cancelled = true; };
  }, [accountId, nonce]);

  if (accountId === null) return null;

  return (
    <div className="border-b px-4 py-2 text-xs">
      {error ? (
        <span className="text-destructive">{error}</span>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-muted-foreground">
            {stats.noteCount} notes · {kb(stats.totalBytes)}
          </span>
          <span className="text-muted-foreground" title="Rough estimate at 4 bytes per token, not a tokenizer count.">
            est. context per retrieval: {tokens(stats.estimatedTokens.median)} median ·{' '}
            {tokens(stats.estimatedTokens.largest)} largest
          </span>
          <span className="text-muted-foreground" title="Timeline entries per note.">
            timeline:{' '}
            {stats.timelineBuckets.map((b) => `${b.label} ${String(b.count)}`).join(' · ')}
          </span>
          <span className={stats.qualifyingCount > 0 ? '' : 'text-muted-foreground'}>
            {stats.qualifyingCount} qualify for curation
          </span>
        </div>
      )}

      {stats.recentlyCurated.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground">
          <span>recently curated:</span>
          {stats.recentlyCurated.map((n) => (
            <button
              key={n.relPath}
              type="button"
              onClick={() => onSelect?.(n.relPath)}
              className="rounded border px-1.5 py-0.5 hover:bg-accent"
              title={`Curated ${n.curatedAt}. Every run commits as "Curation" — git revert in the vault undoes it.`}
            >
              {n.relPath}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default BrainStatsPanel;
```

- [ ] **Step 2: Add the Curate switch to the queue panel**

In `src/components/brain/BrainQueuePanel.tsx`:

Add beside the other key constants at line 16:

```tsx
const CURATE_KEY = 'brain.curate';
```

Add state beside `paused`:

```tsx
  const [curate, setCurate] = useState(false);
```

Extend the mount-time settings read (line 61) to include it:

```tsx
    void Promise.all([
      api.getSetting(AUTO_INDEX_KEY),
      api.getSetting(PAUSED_KEY),
      api.getSetting(CURATE_KEY),
    ])
      .then(([auto, pause, cur]) => {
        if (cancelled) return;
        setAutoIndex(auto === 'true');
        setPaused(pause === 'true');
        setCurate(cur === 'true');
      })
```

Add the switch after the Pause switch:

```tsx
        <SettingSwitch
          label="Curate"
          title="Compress long notes when a session closes, so retrieving them costs less context. Off by default — it spends tokens unattended and rewrites existing notes. Every run commits as 'Curation', so git revert in the vault undoes it."
          checked={curate}
          onChange={(next) => { setSwitch(CURATE_KEY, next, setCurate); }}
        />
```

And a manual trigger beside "Backfill", so a run can be provoked without waiting for a session to close:

```tsx
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            run(async () => {
              const n = await api.brainEnqueueCuration(accountId);
              return `queued ${String(n)} for curation`;
            });
          }}
          className="rounded-md border px-2 py-1 hover:bg-accent disabled:opacity-50"
        >
          Curate
        </button>
```

- [ ] **Step 3: Render the stats panel in the tab**

In `src/components/brain/BrainTab.tsx`, import `BrainStatsPanel` and render it directly above `<BrainQueuePanel …/>`, passing the same `accountId` and the note-selection handler already wired to `BrainNoteList`:

```tsx
      <BrainStatsPanel accountId={accountId} onSelect={setSelected} />
```

Match the surrounding prop names — read the file before editing; the selection setter may be named differently.

- [ ] **Step 4: Verify the renderer**

Run: `npm run check && npm run build`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/brain/BrainStatsPanel.tsx src/components/brain/BrainQueuePanel.tsx src/components/brain/BrainTab.tsx
git commit -m "feat(brain): stats panel, Curate switch and manual trigger

Recently-curated ships as a list in the stats panel rather than a filter in
the note list: the backend already computes curated_at for every note in one
pass, and a filter would mean reading every note over IPC to learn the same
thing."
```

---

## Task 8: enqueue curation on session close

**Files:**
- Modify: `electron/main.ts` (the Brain block at 759-784, and the service construction at 504-523)

**Interfaces:**
- Consumes: `createCurator` from `./services/brain/curation`; `BRAIN_CURATE_SETTING_KEY` from `./services/brain/queue`; `enqueueCuration` from Task 4.

- [ ] **Step 1: Pass the curator into the service**

In `electron/main.ts`, add to the imports beside `createExtractor`:

```ts
import { createCurator } from './services/brain/curation';
```

Add `BRAIN_CURATE_SETTING_KEY` to the existing import from `./services/brain/queue`.

Add to the `createBrainService` options at line 506, beside `extractor`:

```ts
    curator: createCurator(),
```

- [ ] **Step 2: Rewrite the close-time Brain block**

Replace `electron/main.ts:759-784` (the whole `if (db.getSetting(BRAIN_AUTO_INDEX_SETTING_KEY) === 'true') { … }` block) with:

```ts
      // Brain work on close. Both switches are OFF by default — the user opts
      // in once, after seeing real output. Read fresh on every close so a flip
      // applies without a restart, matching the summary gate above.
      //
      // Ownership comes from the config dir the session ran under, never from
      // resolve() (spec §4) — the same rule the session source applies, and it
      // stays correct even if path rules changed after the session ran.
      const autoIndexOn = db.getSetting(BRAIN_AUTO_INDEX_SETTING_KEY) === 'true';
      const curateOn = db.getSetting(BRAIN_CURATE_SETTING_KEY) === 'true';
      if (autoIndexOn || curateOn) {
        const account = accountsService.getAccountByConfigDir(configDir);
        if (account) {
          // Fire-and-forget: session teardown must never wait on Brain work,
          // and the worker yields immediately anyway while another session is
          // still open.
          Promise.resolve()
            .then(() =>
              autoIndexOn ? brainService?.enqueueSource(account.id, sessionId) : undefined,
            )
            // The session just closed in this project, which is exactly when
            // its auto-memory notes and instruction files were most likely
            // edited — the memory tool writes during a session, and a CLAUDE.md
            // is edited in one. Change detection makes the ordinary case a free
            // no-op, so this costs a directory walk and nothing else.
            .then(() =>
              autoIndexOn
                ? brainService?.enqueueProjectSources(account.id, projectPath)
                : undefined,
            )
            .then(() => {
              // Selected from the vault as it stands NOW, so a note pushed over
              // the threshold by the indexing queued just above is picked up on
              // the NEXT close rather than this one. A one-session lag on a
              // 7-day cooldown, and it self-corrects; selecting after the drain
              // would mean draining twice on every close.
              if (curateOn) brainService?.enqueueCuration(account.id);
            })
            .then(() => brainService?.drainQueue())
            .catch((err: unknown) => console.warn('[main] brain work on close failed:', err));
        }
      }
```

The drain now runs whenever either switch is on. Without that, turning Curate on while Auto-index stayed off would queue notes that nothing ever drained.

- [ ] **Step 3: Verify**

Run: `npm run check && npm test`
Expected: clean, and the whole suite green.

- [ ] **Step 4: Commit**

```bash
git add electron/main.ts
git commit -m "feat(brain): enqueue curation on session close

Both switches independently gate their own enqueue, and either one arms the
drain — otherwise Curate-on with Auto-index-off would queue work nothing
ever drained."
```

---

## Task 9: verification and live proof

**Files:**
- Modify: `docs/superpowers/plans/2026-08-11-brain-vault-followups.md`
- Possibly modify: `electron/services/brain/curate.ts` (the constants, if the measurement says so)

- [ ] **Step 1: Run the full gate**

```bash
npm run check
npm run build
npm run test:coverage
```

Expected: all clean. Confirm from the coverage table that `electron/services/brain` is at or above 80% lines. Report the actual figures — not "coverage is fine".

- [ ] **Step 2: Rebuild the Electron ABI**

Run: `npm run rebuild:electron`

Required after any vitest run in this repo — the pretest hook rebuilds `better-sqlite3` for Node, and the app needs it on the Electron ABI. Skipping this leaves the app unable to open its database.

- [ ] **Step 3: Prove the stats panel against a real vault**

Launch the app (`npm start`), open the Brain tab for the personal account, and configure a vault if one is not configured. Run Backfill and let the queue drain enough sessions that some notes accumulate Timeline entries.

Record what the stats panel reports:
- note count, total size, estimated median and largest context cost
- the Timeline histogram
- how many notes qualify at `MIN_TIMELINE_ENTRIES = 8`

- [ ] **Step 4: Decide the threshold from that measurement**

This is the step the whole stats surface exists for.

- If `qualifyingCount` is 0 and the histogram shows most notes in `1–3`, the inherited 8 is theatre on this vault. Lower `MIN_TIMELINE_ENTRIES` to a value the histogram actually supports and say which bucket drove the choice.
- If it is large (say more than a quarter of the vault), 8 is too loose and curation would rewrite most notes on first run. Raise it.
- If it lands somewhere between, keep 8 and record that it was checked rather than assumed.

Change the constant only with the measured reason written beside it.

- [ ] **Step 5: Prove one real curation at Opus**

Press **Curate** in the queue panel, then **Drain now**. Watch one note through.

Then check, in the vault:

```bash
cd <vault>
git log --oneline -5          # a "Curation" commit exists
git show --stat HEAD          # exactly the notes curated, nothing else
git show HEAD                 # read the diff
```

Answer these explicitly, and honestly:
- Does the collapsed prose preserve what actually mattered, or does it read as filler?
- Are the promoted facts real, or invented? (Plan 4a and Plan 6 both caught invented content that zod validated happily.)
- Did the `Open items` and `Assistant notes` sections survive byte-identical?
- Is the date range on the collapsed entry the real span of the removed entries?

- [ ] **Step 6: Confirm the note does not re-curate**

Press **Curate** again immediately. The note just curated must not be queued a second time.

Run: check `brain.enqueueCuration`'s reported count and the queue list.
Expected: the curated note is absent — the three guards each independently block it.

- [ ] **Step 7: Record the findings**

Add an `## Opened by Plan 7 (feat/brain-curation, 2026-08-12)` section at the top of the "Opened by" sequence in `docs/superpowers/plans/2026-08-11-brain-vault-followups.md`, matching the style of the Plan 6 and Plan 5 sections. Include:

- The measured stats: note count, size, estimated context cost, the histogram.
- What `MIN_TIMELINE_ENTRIES` was set to and why — the number the measurement supported, not the number that was inherited.
- The verdict on the one real curation: collapsed prose quality, whether promoted facts were real, whether human sections survived.
- Anything that surprised you. Every prior plan's most valuable finding came from running the real corpus rather than a fixture.
- Explicitly note anything NOT verified, the way Plans 5 and 6 both did for the in-app live round trip.

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/plans/2026-08-11-brain-vault-followups.md electron/services/brain/curate.ts
git commit -m "docs(brain): Plan 7 findings, and the measured curation threshold"
```

---

## Self-review

**Spec coverage.** §1 (model never deletes) → Task 1, pinned by the date-range and heading-stripping tests. §2 (pure fold, four guards, constants, re-qualification) → Task 1 + Task 4. §3 (schema, prompt, Opus pin, retry-once) → Task 2. §4 (queue transport, three service methods, re-check before spending) → Tasks 3 and 4. §5 (statistics) → Task 5 + Task 7. §6 (inspection: `Curation` commit, recently-curated) → Task 4 writes the commit, Task 7 surfaces the list, Task 9 Step 5 reads the git history. §7 (error handling) — every row has a test: unparseable reply (Task 2 + Task 4's untouched-note test), no-longer-qualifies and missing note (Task 4), no Timeline (Task 1), dedup of promoted facts (Task 1's Key facts test), heading stripping (Task 1), git failure (existing `lastGitError` path, unchanged), per-item failure (Task 3). §8 (testing, vacuous-stub trap, live proof) → Tasks 1–5 and Task 9.

**Trigger.** Spec §"Decisions" says enqueue on session close behind `brain.curate` default off → Task 3 defines the key, Task 7 the switch, Task 8 the wiring.

**One deliberate deviation from the spec, flagged in Task 7:** recently-curated ships as a list in the stats panel rather than a filter in the note list, because the backend already computes it in one pass and a filter would cost N IPC reads for the same information.

**Type consistency.** `CurationResult` is declared once in `curate.ts` and imported by `curation.ts`, which asserts its zod schema matches at compile time. `CurationInput` uses `noteType`, and Task 4 passes `note.frontmatter.type` into it. `QueueWorkerDeps.process(entry)` is the only worker dependency after Task 3 and all four call sites move in that task. `VaultStats` is defined in `stats.ts`, re-exported through the registry's `stats()`, mirrored as `BrainVaultStats` in `api.ts`, and hand-mirrored once more in `brain-handlers.ts`'s `emptyStats()` — that third copy is deliberate (the handler layer does not import services for a fallback shape) and `brain-ipc.test.ts` is what keeps it honest.

**Constants** are named identically everywhere: `MIN_TIMELINE_ENTRIES`, `RETAIN_RECENT`, `COOLDOWN_DAYS`, `MAX_NOTES_PER_RUN`, `CURATION_MODEL`, `CURATION_SOURCE_ID`, `BRAIN_CURATE_SETTING_KEY`, `BYTES_PER_TOKEN`.
