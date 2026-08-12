# Brain Extraction and Merge Implementation Plan (Plan 4a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn one admitted session into real notes in the owning account's vault — zod-validated LLM extraction, a pure merge, and a manual "Index this one" button — so generated notes can be read before anything runs unattended.

**Architecture:** `distill()`'s bounded prose goes to one headless `claude -p` call pinned to Haiku, running under the **owning** account's `CLAUDE_CONFIG_DIR`, returning JSON validated by zod. A pure `merge()` folds each extracted entity into the existing note (or creates it), owning dedup, alias union, section ordering and frontmatter stamping. The service writes, indexes and commits; the Sources pane triggers it one item at a time.

**Tech Stack:** TypeScript, Electron main process, zod 4.4.3 (already a dependency), the existing `createSummaryQueryRunner` CLI runner, Vitest.

## Global Constraints

- **This is the first LLM spend.** One call per admitted item, `BATCH_SIZE = 1` (spec §8). No batching, no parallelism, no automatic triggering — Plan 4b owns the queue.
- **The owning account's `CLAUDE_CONFIG_DIR`, not a resolved or default one** (spec §8). Indexing a work transcript through the personal account pushes work content through the wrong subscription.
- Model is **pinned to Haiku** (`claude-haiku-4-5`), not the account's session default and not the summary model.
- **Validation failure retries once, then marks the item `failed`** with the error visible in the tab. A failed item never blocks anything (spec §8).
- `merge()` is **pure**: no I/O, no model, no clock it does not receive as an argument. Idempotency is the property to test hardest — indexing the same session twice must produce a **byte-identical** note (spec §9).
- The Brain is auxiliary. An extraction failure must never break a session, block the UI, or crash the main process.
- TDD required; 80% lines on backend. Verification gate: `npm run check`, `npm run build`, `npm run test:coverage`, then `npm run rebuild:electron`.

## Decisions Carried In

Answered before planning, and binding on this plan:

1. **Prompt-preserving truncation** (Task 1). Measurement on the live corpus: median admitted transcript is 1.4MB against an 8KB ceiling, so essentially every session truncates, and oldest-first dropped **every** user prompt from a real 1.06MB session. Prompts are the most information-dense rows; a note describing what was said without what was asked is a weaker note. This deviates from spec §6's literal oldest-first, deliberately.
2. **Split from the queue.** This plan ends at a manual, one-item-at-a-time button. Plan 4b adds the `brain_queue` worker, the operational pane (spec §14) and lifecycle-event enqueue.
3. **Backfill everything on first run** — a Plan 4b decision, recorded here so 4b's author does not re-litigate it. All 142 currently-admitted sessions get indexed when the queue first runs.

## Prior Art To Read Before Starting

- `electron/services/sessions/summary-query.ts` — `createSummaryQueryRunner` / `runCliOnce`. **Reuse this; do not write a second CLI runner.** It already spawns `claude -p --output-format json` with a per-call `configDir` and `model`, pins a stable scratch cwd, and sweeps the throwaway JSONL afterwards. That sweep matters twice over: the Brain's own discovery already excludes `omnifex-summary-scratch` projects, so extraction calls cannot be re-indexed by the Brain.
- `electron/services/brain/vault.ts:54` — `notePath(type, name)` already maps an entity type and name to a vault-relative path. No new naming logic is needed.
- `electron/services/brain/types.ts` — `NoteFrontmatter` / `ParsedNote`, and `NOTE_FOLDERS`.
- Spec §2 (note format), §8 (extraction), §9 (merge).

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `electron/services/brain/extract.ts` | zod schema, the extraction prompt, tolerant JSON parsing, retry-once. Knows nothing about vaults. |
| `electron/services/brain/merge.ts` | Pure `merge(existing, entity, provenance) → ParsedNote`. No I/O, no clock. |
| `electron/__tests__/brain-extract.test.ts` | Schema validation, fence-wrapped JSON, retry, failure shapes. |
| `electron/__tests__/brain-merge.test.ts` | Idempotency above all, plus dedup, alias union, section ordering. |

**Modified:** `electron/services/brain/distill.ts` (Task 1), `electron/services/brain/registry.ts` (Task 5), `electron/ipc/brain-handlers.ts`, `electron/ipc/channels.ts`, `electron/main.ts`, `src/lib/api.ts`, `src/components/brain/BrainSources.tsx`, and the matching test files.

---

### Task 1: Prompt-preserving truncation

**Files:**
- Modify: `electron/services/brain/distill.ts` (`truncateOldestFirst`, and the chunk building in `distillTranscript`)
- Modify: `electron/__tests__/brain-distill.test.ts`

**Interfaces:**
- Produces: unchanged public surface — `distillTranscript(jsonl, sessionId): DistilledItem`. Only the truncation policy changes.

- [ ] **Step 1: Write the failing test**

```ts
  it('keeps every prompt when truncating, and spends what is left on the newest replies', () => {
    const filler = 'z'.repeat(1_500);
    const rows: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      rows.push(JSON.stringify({
        type: 'user', uuid: `u${i}`, timestamp: '2026-08-01T10:00:00.000Z',
        message: { role: 'user', content: `PROMPT-${i}` },
      }));
      rows.push(JSON.stringify({
        type: 'assistant', uuid: `a${i}`, timestamp: '2026-08-01T10:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: `REPLY-${i} ${filler}` }] },
      }));
    }
    const { prose, truncated } = distillTranscript(rows.join('\n'), 's');

    expect(truncated).toBe(true);
    expect(prose.length).toBeLessThanOrEqual(DISTILL_MAX_CHARS);
    // Every prompt survives — this is the whole point of the policy. Measured
    // on the real corpus, plain oldest-first dropped ALL of them.
    for (let i = 0; i < 10; i += 1) expect(prose).toContain(`PROMPT-${i}`);
    // Replies are sacrificed oldest-first, so the newest one survives and the
    // oldest does not.
    expect(prose).toContain('REPLY-9');
    expect(prose).not.toContain('REPLY-0 ');
    expect(prose).toContain('elided');
  });

  it('keeps prompts in transcript order, not grouped at the end', () => {
    const filler = 'z'.repeat(4_000);
    const rows = [
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-08-01T10:00:00.000Z',
        message: { role: 'user', content: 'FIRST-ASK' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-08-01T10:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: `OLD-REPLY ${filler}` }] } }),
      JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-08-01T10:00:02.000Z',
        message: { role: 'user', content: 'SECOND-ASK' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', timestamp: '2026-08-01T10:00:03.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: `NEW-REPLY ${filler}` }] } }),
    ];
    const { prose } = distillTranscript(rows.join('\n'), 's');
    // Reordering would make the transcript read as a different conversation
    // than the one that happened.
    expect(prose.indexOf('FIRST-ASK')).toBeLessThan(prose.indexOf('SECOND-ASK'));
  });

  it('still truncates prompts when the prompts alone exceed the ceiling', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({ type: 'user', uuid: `u${i}`, timestamp: '2026-08-01T10:00:00.000Z',
        message: { role: 'user', content: `P${i} ${'q'.repeat(2_000)}` } }));
    const { prose, truncated } = distillTranscript(rows.join('\n'), 's');
    // The ceiling is a hard budget. "Keep every prompt" is a PRIORITY, not an
    // exemption — otherwise one pathological session blows the bound that
    // makes extraction cost predictable.
    expect(truncated).toBe(true);
    expect(prose.length).toBeLessThanOrEqual(DISTILL_MAX_CHARS);
    expect(prose).toContain('P5');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run electron/__tests__/brain-distill.test.ts -t 'keeps every prompt'`
Expected: FAIL — the current policy drops oldest chunks regardless of kind, so `PROMPT-0` is gone.

- [ ] **Step 3: Implement**

Chunks need a kind so the budget can prioritise. In `distillTranscript`, build `{ kind: 'prompt' | 'prose'; text: string }[]` instead of bare strings, then replace `truncateOldestFirst` with:

```ts
interface Chunk {
  kind: 'prompt' | 'prose';
  text: string;
}

/**
 * Trim to the ceiling, sacrificing assistant replies before user prompts.
 *
 * Spec §6 says oldest-first. This keeps that ordering WITHIN each kind but
 * spends the budget on prompts first, because the measured behaviour of plain
 * oldest-first on this corpus was that it dropped every prompt: the median
 * admitted transcript is 1.4MB against an 8KB ceiling, and assistant prose
 * outweighs prompts by roughly 9:1. A note that records what was said without
 * what was asked is the weaker half of the session.
 *
 * "Keep every prompt" is a PRIORITY, not an exemption. When the prompts alone
 * exceed the budget they are themselves dropped oldest-first, because the
 * ceiling is what makes extraction cost predictable.
 *
 * Output order is always transcript order. Reordering would make the prose
 * read as a different conversation than the one that happened.
 */
function truncateWithPromptPriority(chunks: Chunk[]): { prose: string; truncated: boolean } {
  const joined = chunks.map((c) => c.text).join('\n\n');
  if (joined.length <= DISTILL_MAX_CHARS) return { prose: joined, truncated: false };

  const budget = DISTILL_MAX_CHARS - TRUNCATION_MARKER.length;
  const keep = new Set<number>();
  let used = 0;

  // Pass 1: prompts, newest-first so the most recent survive a prompt-only
  // overflow. Pass 2: replies, same order, filling whatever is left.
  for (const kind of ['prompt', 'prose'] as const) {
    for (let i = chunks.length - 1; i >= 0; i -= 1) {
      if (chunks[i].kind !== kind) continue;
      const cost = chunks[i].text.length + (keep.size > 0 ? 2 : 0);
      if (used + cost > budget) continue;
      keep.add(i);
      used += cost;
    }
  }

  // A single chunk larger than the whole budget still has to yield something,
  // or a session with one enormous prompt distills to nothing but a marker.
  if (keep.size === 0) {
    return {
      prose: TRUNCATION_MARKER + chunks[chunks.length - 1].text.slice(-budget),
      truncated: true,
    };
  }

  const kept = chunks.filter((_, i) => keep.has(i)).map((c) => c.text);
  return { prose: TRUNCATION_MARKER + kept.join('\n\n'), truncated: true };
}
```

Note the `continue` rather than `break` in the inner loop: a chunk too large to fit must not stop smaller later ones from being considered, or one long reply near the start silently costs every reply after it.

- [ ] **Step 4: Run the whole distill suite**

Run: `npx vitest run electron/__tests__/brain-distill.test.ts`
Expected: PASS. The existing `truncates oldest-first with an explicit marker` test is prompt-only input, so it still passes unchanged — check that it does rather than editing it.

- [ ] **Step 5: Re-measure against a real transcript**

Write a throwaway test under `electron/__tests__/` that distils a real session from `~/.claude-personal/projects/` and writes the result to a file (vitest suppresses console output in this repo). Confirm every `USER:` turn now survives. Delete the file before committing.

- [ ] **Step 6: Commit**

```bash
git add electron/services/brain/distill.ts electron/__tests__/brain-distill.test.ts
git commit -m "fix(brain): keep every prompt when distillation truncates

Measured on the live corpus, plain oldest-first dropped every user prompt
from a real 1.06MB session: median admitted transcript is 1.4MB against an
8KB ceiling and assistant prose outweighs prompts ~9:1. Prompts now claim
the budget first, replies fill the rest, and transcript order is preserved.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The extraction schema and response parsing

**Files:**
- Create: `electron/services/brain/extract.ts`
- Test: `electron/__tests__/brain-extract.test.ts`

**Interfaces:**
- Produces:
  - `ExtractionSchema` (zod), `type Extraction`, `type ExtractedEntity`
  - `parseExtraction(raw: string): Extraction` — throws `ExtractionParseError` with a message the Brain tab can show
  - `class ExtractionParseError extends Error`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { parseExtraction, ExtractionParseError } from '../services/brain/extract';

const VALID = {
  entities: [{
    type: 'Subsystem', name: 'Permission decider',
    aliases: ['permission-prompt-tool'], keywords: ['permissions', 'stdio'],
    summary: 'The stdio bridge that enforces mid-session permission changes.',
    links: [{ target: 'Projects/omnifex', relation: 'lives in' }],
    timelineEntry: 'Reworked the decider to handle every mode, not just bypass.',
    decisions: [{ date: '2026-05-31', text: 'Enforce in OmniFex, not the CLI.' }],
    keyFacts: ['Only bypass was handled before this change.'],
  }],
};

describe('parseExtraction', () => {
  it('parses a clean JSON reply', () => {
    expect(parseExtraction(JSON.stringify(VALID)).entities).toHaveLength(1);
  });

  it('parses JSON wrapped in a markdown fence', () => {
    // The CLI returns the model's text verbatim, and a model asked for JSON
    // fences it more often than not. Rejecting that would fail most calls for
    // a reason that has nothing to do with the content.
    const fenced = '```json\n' + JSON.stringify(VALID) + '\n```';
    expect(parseExtraction(fenced).entities).toHaveLength(1);
  });

  it('parses JSON with prose before and after it', () => {
    const chatty = `Here is the extraction:\n${JSON.stringify(VALID)}\nLet me know if you need more.`;
    expect(parseExtraction(chatty).entities).toHaveLength(1);
  });

  it('defaults the optional collections so merge never sees undefined', () => {
    const minimal = { entities: [{ type: 'Topic', name: 'X', summary: 'A topic.' }] };
    const parsed = parseExtraction(JSON.stringify(minimal));
    expect(parsed.entities[0].aliases).toEqual([]);
    expect(parsed.entities[0].keywords).toEqual([]);
    expect(parsed.entities[0].links).toEqual([]);
    expect(parsed.entities[0].decisions).toEqual([]);
    expect(parsed.entities[0].keyFacts).toEqual([]);
  });

  it('rejects an unknown entity type with a readable message', () => {
    const bad = { entities: [{ type: 'Person', name: 'X', summary: 'y' }] };
    expect(() => parseExtraction(JSON.stringify(bad))).toThrow(ExtractionParseError);
    expect(() => parseExtraction(JSON.stringify(bad))).toThrow(/type/i);
  });

  it('rejects a reply containing no JSON at all', () => {
    expect(() => parseExtraction('I could not find anything worth noting.'))
      .toThrow(ExtractionParseError);
  });

  it('rejects an empty entity name, which would produce an unnameable note', () => {
    const bad = { entities: [{ type: 'Topic', name: '   ', summary: 'y' }] };
    expect(() => parseExtraction(JSON.stringify(bad))).toThrow(ExtractionParseError);
  });

  it('accepts an empty entity list — a session can be worth nothing', () => {
    expect(parseExtraction('{"entities":[]}').entities).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run electron/__tests__/brain-extract.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the schema and parser**

```ts
import { z } from 'zod';

/**
 * The extraction contract (spec §8).
 *
 * Optional collections default to `[]` rather than being left undefined: the
 * merge is a pure function over these, and every `?? []` it would otherwise
 * need is a place a future edit forgets one.
 */
const EntitySchema = z.object({
  type: z.enum(['Project', 'Subsystem', 'Topic']),
  name: z.string().trim().min(1),
  aliases: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  summary: z.string(),
  links: z.array(z.object({ target: z.string(), relation: z.string() })).default([]),
  timelineEntry: z.string().optional(),
  decisions: z.array(z.object({ date: z.string(), text: z.string() })).default([]),
  keyFacts: z.array(z.string()).default([]),
});

export const ExtractionSchema = z.object({ entities: z.array(EntitySchema) });
export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractedEntity = z.infer<typeof EntitySchema>;

/** A model reply that could not be turned into a valid Extraction. */
export class ExtractionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionParseError';
  }
}

/**
 * The first balanced `{...}` span in a string, or null.
 *
 * Needed because the CLI hands back the model's text verbatim, and a model
 * asked for JSON routinely fences it or introduces it with a sentence. A
 * greedy first-`{`-to-last-`}` slice fails on any trailing prose containing a
 * brace, so this counts depth and respects string literals.
 */
function firstJsonObject(raw: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth += 1; continue; }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Validate a model reply into an Extraction, or throw with a message worth
 * showing a human.
 *
 * Throwing rather than returning null is deliberate: the caller's retry-once
 * policy needs to distinguish "the model produced something unusable" from
 * "the model produced an empty result", and an empty entity list is a valid,
 * final answer — plenty of sessions are worth nothing.
 */
export function parseExtraction(raw: string): Extraction {
  const json = firstJsonObject(raw);
  if (json === null) {
    throw new ExtractionParseError(`no JSON object in reply: ${raw.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new ExtractionParseError(`reply is not valid JSON: ${(err as Error).message}`);
  }
  const result = ExtractionSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new ExtractionParseError(
      `extraction failed validation at ${first.path.join('.') || '(root)'}: ${first.message}`,
    );
  }
  return result.data;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run electron/__tests__/brain-extract.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/services/brain/extract.ts electron/__tests__/brain-extract.test.ts
git commit -m "feat(brain): zod extraction schema and tolerant reply parsing

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The extraction prompt and the Haiku call

**Files:**
- Modify: `electron/services/brain/extract.ts`
- Modify: `electron/__tests__/brain-extract.test.ts`

**Interfaces:**
- Consumes: `DistilledItem` from `./sources/types`; `createSummaryQueryRunner` from `../sessions/summary-query`.
- Produces:
  - `EXTRACTION_MODEL = 'claude-haiku-4-5'`
  - `buildExtractionPrompt(item: DistilledItem): string`
  - `createExtractor(deps: ExtractorDeps): Extractor`, where
    `Extractor = (item: DistilledItem, configDir: string) => Promise<Extraction>`

- [ ] **Step 1: Write the failing test**

```ts
  describe('createExtractor', () => {
    const item = {
      prose: 'USER: add a probe\nASSISTANT: added one',
      truncated: false,
      metadata: {
        sessionId: 'sess-a', projectPath: '/repo', gitBranch: 'main',
        models: ['claude-opus-5'], cliVersion: '2.1.228',
        startedAt: '2026-08-01T10:00:00.000Z', endedAt: '2026-08-01T10:05:00.000Z',
        durationMs: 300_000, promptCount: 2, proseCount: 2,
        filesTouched: ['/repo/a.ts'], terminalStatus: 'completed' as const,
      },
    };

    it('calls the CLI once with Haiku and the owning config dir', async () => {
      const calls: { model?: string; configDir: string; prompt: string }[] = [];
      const extract = createExtractor({
        runQuery: async (opts) => { calls.push(opts); return '{"entities":[]}'; },
      });

      await extract(item, '/Users/dev/.claude-work');

      expect(calls).toHaveLength(1);
      expect(calls[0].model).toBe('claude-haiku-4-5');
      // The OWNING account's dir. Indexing a work transcript through the
      // personal account would push work content through the wrong
      // subscription (spec §8).
      expect(calls[0].configDir).toBe('/Users/dev/.claude-work');
    });

    it('puts the distilled prose and the deterministic metadata in the prompt', async () => {
      let prompt = '';
      const extract = createExtractor({
        runQuery: async (opts) => { prompt = opts.prompt; return '{"entities":[]}'; },
      });
      await extract(item, '/cfg');
      expect(prompt).toContain('USER: add a probe');
      expect(prompt).toContain('/repo');
      expect(prompt).toContain('main');
      // The model supplies prose and aliases only; these facts are handed to
      // it, never asked for (spec §6).
      expect(prompt).toContain('sess-a');
    });

    it('tells the model when it is looking at a truncated tail', async () => {
      let prompt = '';
      const extract = createExtractor({
        runQuery: async (opts) => { prompt = opts.prompt; return '{"entities":[]}'; },
      });
      await extract({ ...item, truncated: true }, '/cfg');
      expect(prompt).toMatch(/truncat|partial|tail/i);
    });

    it('retries exactly once on an invalid reply, then succeeds', async () => {
      let n = 0;
      const extract = createExtractor({
        runQuery: async () => {
          n += 1;
          return n === 1 ? 'sorry, no idea' : '{"entities":[]}';
        },
      });
      await expect(extract(item, '/cfg')).resolves.toEqual({ entities: [] });
      expect(n).toBe(2);
    });

    it('gives up after the retry and throws the validation error', async () => {
      let n = 0;
      const extract = createExtractor({
        runQuery: async () => { n += 1; return 'still not json'; },
      });
      // Spec §8: one retry, then `failed` with the error visible. Retrying
      // further would spend tokens on a model that has already demonstrated it
      // cannot answer this one.
      await expect(extract(item, '/cfg')).rejects.toThrow(ExtractionParseError);
      expect(n).toBe(2);
    });

    it('does not retry a transport failure', async () => {
      let n = 0;
      const extract = createExtractor({
        runQuery: async () => { n += 1; throw new Error('claude -p exited 1: not logged in'); },
      });
      // A spawn/auth failure is not a bad answer — retrying it immediately
      // just fails twice as fast and doubles the log noise.
      await expect(extract(item, '/cfg')).rejects.toThrow(/not logged in/);
      expect(n).toBe(1);
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run electron/__tests__/brain-extract.test.ts -t createExtractor`
Expected: FAIL — `createExtractor` is not exported.

- [ ] **Step 3: Implement**

```ts
import type { DistilledItem } from './sources/types';
import { createSummaryQueryRunner } from '../sessions/summary-query';

/**
 * Pinned, not configurable (spec §8). Extraction is a high-volume, low-
 * judgement task, and letting it inherit an account's session default would
 * quietly bill Opus for it.
 */
export const EXTRACTION_MODEL = 'claude-haiku-4-5';

export interface ExtractorDeps {
  /** Injected in tests. Defaults to the shared `claude -p` runner. */
  runQuery?: (opts: { prompt: string; model: string; configDir: string }) => Promise<string>;
}

export type Extractor = (item: DistilledItem, configDir: string) => Promise<Extraction>;

export function buildExtractionPrompt(item: DistilledItem): string {
  const m = item.metadata;
  // Deterministic facts are STATED, not requested. The model's job is prose
  // and aliases; asking it to restate a branch name it can see is an
  // opportunity for it to get one wrong (spec §6).
  const facts = [
    `session: ${m.sessionId}`,
    `project: ${m.projectPath ?? 'unknown'}`,
    `branch: ${m.gitBranch ?? 'unknown'}`,
    `started: ${m.startedAt ?? 'unknown'}`,
    `turns: ${m.promptCount} prompts, ${m.proseCount} replies`,
    `files touched: ${m.filesTouched.length > 0 ? m.filesTouched.join(', ') : 'none'}`,
    `outcome: ${m.terminalStatus}`,
  ].join('\n');

  const truncationNote = item.truncated
    ? '\nNOTE: this transcript was TRUNCATED to fit a size limit. You are seeing ' +
      'every user prompt but only the most recent assistant replies. Do not ' +
      'describe the session as if you saw all of it.\n'
    : '';

  return `You are extracting durable engineering knowledge from one coding session.

Return ONLY a JSON object matching this shape, with no commentary:

{"entities":[{"type":"Project"|"Subsystem"|"Topic","name":string,"aliases":[string],
"keywords":[string],"summary":string,"links":[{"target":string,"relation":string}],
"timelineEntry":string,"decisions":[{"date":"YYYY-MM-DD","text":string}],
"keyFacts":[string]}]}

Rules:
- Extract only what will still matter in six months. A session that decided
  nothing durable should return {"entities":[]}.
- \`aliases\` and \`keywords\` are what make this searchable later. Include the
  literal identifiers a developer would type: file names, function names,
  flags, error strings. Prefer exact spellings over descriptions.
- \`summary\` is 2-3 sentences of plain prose.
- \`links.target\` names another entity, e.g. "Projects/omnifex".
- \`timelineEntry\` is one sentence describing what THIS session did.
- Use the facts below rather than inferring them.

FACTS
${facts}
${truncationNote}
TRANSCRIPT
${item.prose}`;
}

export function createExtractor(deps: ExtractorDeps = {}): Extractor {
  const runQuery = deps.runQuery ?? createSummaryQueryRunner();

  return async function extract(item, configDir) {
    const prompt = buildExtractionPrompt(item);
    // BATCH_SIZE = 1, adopted from Rowboat (spec §8): one item per call, so a
    // bad reply damages exactly one note and the retry is cheap.
    const reply = await runQuery({ prompt, model: EXTRACTION_MODEL, configDir });
    try {
      return parseExtraction(reply);
    } catch (err) {
      if (!(err instanceof ExtractionParseError)) throw err;
      // Exactly one retry (spec §8). A transport error never reaches here —
      // `runQuery` rejects and that propagates unretried, because a spawn or
      // auth failure is not a bad answer.
      const second = await runQuery({ prompt, model: EXTRACTION_MODEL, configDir });
      return parseExtraction(second);
    }
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run electron/__tests__/brain-extract.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/services/brain/extract.ts electron/__tests__/brain-extract.test.ts
git commit -m "feat(brain): extraction prompt and pinned-Haiku CLI call

Reuses createSummaryQueryRunner rather than adding a second CLI runner: it
already sweeps its scratch JSONL, which the Brain's own discovery excludes,
so extraction calls cannot be re-indexed by the Brain.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `merge.ts` — the pure fold

The file the spec singles out for the hardest testing (§9, §Testing). Idempotency above all.

**Files:**
- Create: `electron/services/brain/merge.ts`
- Test: `electron/__tests__/brain-merge.test.ts`

**Interfaces:**
- Consumes: `ParsedNote`, `NoteFrontmatter` from `./types`; `ExtractedEntity` from `./extract`.
- Produces:
  - `interface Provenance { sourceKey: string; date: string; projectLink?: string }`
  - `merge(existing: ParsedNote | null, entity: ExtractedEntity, provenance: Provenance): ParsedNote`
  - `SECTION_ORDER: readonly string[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { merge, type Provenance } from '../services/brain/merge';
import type { ExtractedEntity } from '../services/brain/extract';

const entity: ExtractedEntity = {
  type: 'Subsystem', name: 'Permission decider',
  aliases: ['decider'], keywords: ['permissions', 'stdio'],
  summary: 'The stdio bridge enforcing permission changes.',
  links: [{ target: 'Projects/omnifex', relation: 'lives in' }],
  timelineEntry: 'Reworked to handle every mode, not just bypass.',
  decisions: [{ date: '2026-05-31', text: 'Enforce in OmniFex, not the CLI.' }],
  keyFacts: ['Only bypass was handled before.'],
};

const prov: Provenance = { sourceKey: 'session:abc123', date: '2026-05-31' };

describe('merge', () => {
  it('creates a note with the spec section order', () => {
    const note = merge(null, entity, prov);
    const order = ['## Summary', '## Connected to', '## Timeline', '## Decisions',
                   '## Key facts', '## Open items', '## Assistant notes'];
    let last = -1;
    for (const heading of order) {
      const at = note.body.indexOf(heading);
      expect(at, `${heading} present`).toBeGreaterThan(-1);
      expect(at, `${heading} in order`).toBeGreaterThan(last);
      last = at;
    }
    expect(note.body.startsWith('# Permission decider')).toBe(true);
    expect(note.frontmatter.type).toBe('Subsystem');
    expect(note.frontmatter.sources).toEqual(['session:abc123']);
  });

  it('is idempotent: merging the same extraction twice is byte-identical', () => {
    const once = merge(null, entity, prov);
    const twice = merge(once, entity, prov);
    // The property the spec names as the one to test hardest. If this drifts,
    // every re-index rewrites the vault and git history becomes noise.
    expect(twice).toEqual(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('is idempotent even on a later date', () => {
    const once = merge(null, entity, prov);
    const twice = merge(once, entity, { ...prov, date: '2026-09-01' });
    // `updated` bumps only when content actually changed. Stamping it
    // unconditionally would make the idempotency property untestable and
    // every re-index a commit.
    expect(twice.frontmatter.updated).toBe(once.frontmatter.updated);
    expect(twice).toEqual(once);
  });

  it('never appends a Timeline entry whose source key is already recorded', () => {
    const once = merge(null, entity, prov);
    const twice = merge(once, { ...entity, timelineEntry: 'A different sentence.' }, prov);
    // Dedup is by SOURCE KEY, not by text: re-running extraction on one
    // session legitimately produces different wording, and matching on text
    // would append a near-duplicate line every time.
    expect(twice.body.match(/^- \*\*/gm)?.length).toBe(once.body.match(/^- \*\*/gm)?.length);
  });

  it('appends a Timeline entry from a genuinely new source', () => {
    const first = merge(null, entity, prov);
    const second = merge(first, { ...entity, timelineEntry: 'Later work.' },
      { sourceKey: 'session:def456', date: '2026-06-02' });
    expect(second.body).toContain('Later work.');
    expect(second.frontmatter.sources).toEqual(['session:abc123', 'session:def456']);
    // Chronological, so the note reads as a history.
    expect(second.body.indexOf('2026-05-31')).toBeLessThan(second.body.indexOf('2026-06-02'));
  });

  it('unions aliases and keywords without duplicating or reordering', () => {
    const first = merge(null, entity, prov);
    const second = merge(first,
      { ...entity, aliases: ['decider', 'permission-prompt-tool'], keywords: ['stdio', 'acceptEdits'] },
      { sourceKey: 'session:def456', date: '2026-06-02' });
    expect(second.frontmatter.aliases).toEqual(['decider', 'permission-prompt-tool']);
    expect(second.frontmatter.keywords).toEqual(['permissions', 'stdio', 'acceptEdits']);
  });

  it('preserves hand-written text in Open items and Assistant notes', () => {
    const first = merge(null, entity, prov);
    const edited: ParsedNote = {
      ...first,
      body: first.body.replace('## Open items\n', '## Open items\n- check the decider on Windows\n'),
    };
    const second = merge(edited, entity, { sourceKey: 'session:def456', date: '2026-06-02' });
    // The user edits notes in this app. An extraction that silently discarded
    // their text would make the tab's edit box a trap.
    expect(second.body).toContain('check the decider on Windows');
  });

  it('replaces the Summary rather than accumulating summaries', () => {
    const first = merge(null, entity, prov);
    const second = merge(first, { ...entity, summary: 'A newer, better summary.' },
      { sourceKey: 'session:def456', date: '2026-06-02' });
    expect(second.body).toContain('A newer, better summary.');
    expect(second.body).not.toContain('The stdio bridge enforcing permission changes.');
  });

  it('dedupes decisions and key facts by text', () => {
    const first = merge(null, entity, prov);
    const second = merge(first, entity, { sourceKey: 'session:def456', date: '2026-06-02' });
    expect(second.body.match(/Enforce in OmniFex/g)).toHaveLength(1);
    expect(second.body.match(/Only bypass was handled before/g)).toHaveLength(1);
  });

  it('stamps the project link when given one', () => {
    const note = merge(null, entity, { ...prov, projectLink: '[[Projects/omnifex]]' });
    expect(note.frontmatter.project).toBe('[[Projects/omnifex]]');
  });

  it('does no I/O and takes its date from the caller', () => {
    // No clock inside: a pure function that reads Date.now() is not pure, and
    // its idempotency test becomes a race against midnight.
    const note = merge(null, entity, { sourceKey: 's:1', date: '2020-01-01' });
    expect(note.frontmatter.created).toBe('2020-01-01');
    expect(note.frontmatter.updated).toBe('2020-01-01');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run electron/__tests__/brain-merge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Write `merge.ts` as a pure fold. Required behaviour, all pinned by the tests above:

- Body is `# <name>` followed by the seven sections in `SECTION_ORDER`, always all seven present even when empty.
- Parse the existing body into a section map (heading → lines), apply changes, re-render. Parsing then re-rendering is what makes hand-edited text in untouched sections survive.
- `Summary` is replaced. `Connected to`, `Decisions`, `Key facts` are unioned by text. `Timeline` is appended only when `provenance.sourceKey` is absent from `frontmatter.sources`, and sorted by the leading date.
- `Open items` and `Assistant notes` are never written by merge — they are human and curation territory.
- `sources` is appended in encounter order; `aliases` and `keywords` union preserving first-seen order.
- `created` is set on first write and never changed. `updated` is set to `provenance.date` **only if** the rendered body or the frontmatter differs from the existing one — compute the candidate first, compare, and reuse the old `updated` when nothing moved. That is what makes the idempotency-on-a-later-date test pass.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run electron/__tests__/brain-merge.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/services/brain/merge.ts electron/__tests__/brain-merge.test.ts
git commit -m "feat(brain): pure merge of an extraction into a note

Idempotent by construction: dedup is by source key, and `updated` bumps
only when content actually changed, so re-indexing a session twice yields
a byte-identical note rather than a fresh commit.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `indexSource` on `BrainService`

**Files:**
- Modify: `electron/services/brain/registry.ts`
- Modify: `electron/main.ts`
- Test: `electron/__tests__/brain-session-source.test.ts` (the `BrainService source wiring` block)

**Interfaces:**
- Produces on `BrainService`:
  `indexSource(accountId: number, itemKey: string): Promise<IndexResult>` where

```ts
export interface IndexResult {
  itemKey: string;
  notesWritten: string[];
  skipped: boolean;
  reason: string;
}
```

- `BrainServiceOptions` gains `extractor?: Extractor` and `accounts?: AccountsService` (the config dir for the owning account has to come from somewhere, and the registry currently has no accounts dependency).

- [ ] **Step 1: Write the failing tests**

Cover, with a stub extractor so no token is spent:

```ts
    it('writes a note into the owning account vault and records the item indexed', async () => { /* … */ });
    it('refuses to index an item owned by another account', async () => { /* … */ });
    it('skips an item the gate rejected, without calling the extractor', async () => { /* … */ });
    it('records failed with the error when extraction throws, and does not write', async () => { /* … */ });
    it('is idempotent end to end: indexing twice leaves the note byte-identical', async () => { /* … */ });
    it('uses the owning account config dir for the extraction call', async () => { /* … */ });
    it('throws when the owning account has no vault configured', async () => { /* … */ });
```

The two that matter most: **owning config dir** (a stub extractor asserting which `configDir` it received) and **end-to-end idempotency** (read the note file's bytes after two runs).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run electron/__tests__/brain-session-source.test.ts -t indexSource`
Expected: FAIL — `brain.indexSource is not a function`.

- [ ] **Step 3: Implement**

`indexSource` sequence, all of it inside one method so no caller can do half of it:

1. Find the item across `sources` by `(accountId, itemKey)`. Not found → throw.
2. `admit()`. Rejected → record `skipped` with the reason and return without spending a token.
3. `distill()`.
4. Look up the owning account's `config_dir` via the injected `AccountsService`. Missing → record `blocked` with `no account` and return. **Never** substitute another account's dir.
5. `extractor(distilled, configDir)`. Throws → record `failed` with the message, return; never rethrow into the IPC layer as a crash.
6. For each entity: `handle.vault.notePath(type, name)`, read the existing note if present, `merge()`, `writeNote`, `index.upsert`.
7. One `commitAndRecord(handle, \`Index session ${itemKey}\`)` for the whole item, not per note.
8. `sourceState.record(item, { status: 'indexed' })`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run electron/__tests__/brain-session-source.test.ts && npm run check`

- [ ] **Step 5: Wire the real extractor in `main.ts`**

```ts
  const brainService: BrainService | undefined = createBrainService(db, {
    accounts: accountsService,
    extractor: createExtractor(),
    sources: [createSessionSource({ accounts: accountsService })],
  });
```

- [ ] **Step 6: Commit**

```bash
git add electron/services/brain/registry.ts electron/main.ts electron/__tests__/brain-session-source.test.ts
git commit -m "feat(brain): index one source item into its owning account vault

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: IPC and the "Index this one" button

**Files:**
- Modify: `electron/ipc/channels.ts` (add `brain_index_source`, in sorted position — the IPC test asserts the sorted channel list)
- Modify: `electron/ipc/brain-handlers.ts`, `electron/__tests__/brain-ipc.test.ts`
- Modify: `src/lib/api.ts` (`brainIndexSource`, `BrainIndexResult`)
- Modify: `src/components/brain/BrainSources.tsx`, `src/components/__tests__/BrainSources.test.tsx`

- [ ] **Step 1: Write the failing tests**

Backend: `brain_index_source` requires an accountId, accepts snake_case, and — unlike the read handlers — **throws** when the service is unavailable rather than degrading, because it is a write and a `null` return would report a write that never happened. Follow the existing split documented at the top of `brain-handlers.ts`.

Frontend: an "Index" button appears on the selected item only when `admitted` is true; clicking it calls `api.brainIndexSource(accountId, itemKey)`, disables while in flight, and refreshes the listing on success so `status` becomes `indexed`. A failure renders the message rather than silently doing nothing.

- [ ] **Step 2: Run to verify failure**, then implement, then re-run. The channel-list assertion in `brain-ipc.test.ts` fails first and is the quickest confirmation the channel is wired.

- [ ] **Step 3: Commit**

```bash
git add electron/ipc src/lib/api.ts src/components electron/__tests__ 
git commit -m "feat(brain): index-one-item button in the Sources pane

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Verification and the first real notes

- [ ] **Step 1: Full gate**

```bash
npm run check
npm run build
npm run test:coverage
npm run rebuild:electron
```

Confirm `extract.ts` and `merge.ts` clear 80% lines.

- [ ] **Step 2: Spend the first tokens, deliberately**

Launch the app, open Brain → Sources, pick **one** admitted session, press Index. Then switch to Notes and read what it wrote. Check specifically:

- Are `aliases` and `keywords` the literal identifiers you would actually search for? Spec §2 calls these load-bearing, and they are the extraction prompt's primary job.
- Is the Summary accurate, or does it narrate a truncated tail as if it were the whole session?
- Did it invent entities that do not deserve a note?

- [ ] **Step 3: Index a second session that touches the same subsystem**, and confirm the merge appended a Timeline entry rather than rewriting the note. Then index the **same** session again and confirm `git log` in the vault shows no new commit — the end-to-end idempotency proof.

- [ ] **Step 4: Record what the prose actually looked like** in `docs/superpowers/plans/2026-08-11-brain-vault-followups.md`. Prompt quality is the input to whether Plan 4b should run over all 142 sessions unattended.

- [ ] **Step 5: Commit, then finish the branch**

**REQUIRED SUB-SKILL:** Use superpowers:finishing-a-development-branch.

---

## Self-Review

**Spec coverage.** §8 extraction (zod schema, BATCH_SIZE 1, owning config dir, Haiku, retry-once-then-failed) → Tasks 2, 3, 5. §9 merge (dedup by source key, section ordering, alias union, frontmatter stamping, idempotency) → Task 4. §2 note format → Task 4's section order test. §6's truncation policy → Task 1, with a stated, measured deviation.

**Not covered, on purpose:** §11 queue and §14's operational pane (Plan 4b), §10 curation (step 7), §13 MCP server and §15 `/recall` (step 5).

**Type consistency.** `Extraction` / `ExtractedEntity` are defined in Task 2 and consumed by name in Tasks 3–5. `Provenance` and `merge` are defined in Task 4 and used in Task 5. `Extractor` is defined in Task 3 and injected in Task 5. `DistilledItem` and `SourceItem` are unchanged from Plan 3.

**Known gap an implementer will hit.** Task 5 adds an `accounts` dependency to `createBrainService`, which currently takes only `db`. Every existing construction site (`main.ts`, and several test files) keeps working because it is optional — but `indexSource` must fail loudly rather than silently when it is absent, or a missing dependency becomes a silent no-op indexer.
