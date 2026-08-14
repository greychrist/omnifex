import { z } from 'zod';
import { createSummaryQueryRunner, type CliRunResult } from '../sessions/summary-query';
import type { RunCost } from './sources/state';
import { addRunCosts } from './spend';
import type { DistilledItem, ItemMetadata } from './sources/types';

/**
 * The extraction contract (spec §8).
 *
 * Optional collections default to `[]` rather than being left undefined: the
 * merge is a pure fold over these, and every `?? []` it would otherwise need
 * is a place a future edit forgets one.
 */
/**
 * An entity name is model-supplied, so it is untrusted input for a filesystem
 * path. `vault.notePath` rejects any separator outright, and one bad name
 * would otherwise fail a whole item.
 *
 * Observed from a live run: the prompt shows `links.target` as
 * "Projects/omnifex" and the model generalized that shape to `name`. Taking
 * the last segment is both the obvious intent and consistent with
 * `linkMatchesNote`, which already resolves wikilinks by last segment.
 */
function lastNameSegment(name: string): string {
  return name.split(/[/\\]/).pop()?.trim() ?? '';
}

const EntitySchema = z.object({
  type: z.enum(['Project', 'Subsystem', 'Topic']),
  name: z
    .string()
    .trim()
    .min(1)
    .transform(lastNameSegment)
    .refine((n) => n.length > 0, { message: 'name is empty after removing path segments' }),
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
 *
 * Exported for `curation.ts`, which parses a reply from the same CLI in the
 * same way. A second brace counter would be a second place to get string
 * escaping wrong.
 */
export function firstJsonObject(raw: string): string | null {
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
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
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
    parsed = JSON.parse(json) as unknown;
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

/**
 * Pinned, not configurable: letting extraction inherit an account's session
 * default would quietly bill Opus for a high-volume background task.
 *
 * Spec §8 pins Haiku. This is Sonnet instead, and the reason is measured
 * rather than assumed. The first live extraction at Haiku (session 27b32dad,
 * 1.99MB, 5 notes) produced a note asserting the distiller "detects file
 * changes from git diffs" and parses "decision/fact blocks from prose
 * patterns" — neither of which exists anywhere in `distill.ts`. Working from a
 * truncated tail, it invented plausible internals. zod cannot catch that: it
 * validates shape, not truth, and a confidently wrong note is worse than no
 * note because it will be retrieved and believed later.
 *
 * Opus was considered and rejected on volume: backfill is ~142 sessions, and
 * one extraction already costs ~2.5 minutes of wall-clock at a smaller model.
 */
export const EXTRACTION_MODEL = 'claude-sonnet-5';

export interface ExtractorDeps {
  /**
   * Injected in tests. Defaults to the shared `claude -p` runner, which
   * already pins a stable scratch cwd and sweeps the throwaway JSONL the CLI
   * writes — and the Brain's own discovery excludes that scratch directory, so
   * extraction calls cannot be re-indexed by the Brain.
   */
  runQuery?: (
    opts: { prompt: string; model: string; configDir: string },
  ) => Promise<CliRunResult>;
}

/** What the vault already holds, so a run can converge on existing names. */
export interface ExtractionContext {
  /** Titles of notes already in this account's vault. */
  existingNames: string[];
}

/**
 * An extraction, plus what producing it cost.
 *
 * `run` is optional because not every extractor spends: tests supply canned
 * entities, and a source that translates never reaches a model at all. Absent
 * means "nothing was spent", which the state store treats as "leave whatever
 * was recorded before alone" rather than as zero.
 */
export type ExtractionRun = Extraction & { run?: RunCost };

export type Extractor = (
  item: DistilledItem,
  configDir: string,
  context?: ExtractionContext,
) => Promise<ExtractionRun>;

/** The cost half of a `claude -p` result, in the shape the state store keeps. */
export function runCostOf(r: CliRunResult): RunCost {
  return {
    costUsd: r.costUsd,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheCreationTokens: r.cacheCreationTokens,
  };
}

/**
 * The per-kind wording of the prompt.
 *
 * A switch rather than nested ternaries: the prompt STATES its facts, so each
 * kind has to say only what is true of it — a capture has no prompt count and
 * an instruction file has no session — and a fourth source would otherwise add
 * a fourth level of nesting to five separate expressions. The exhaustive
 * default is what makes adding one a compile error rather than a silent
 * fall-through to session wording.
 */
interface PromptShape {
  preamble: string;
  facts: string;
  /** Names the material, for the "return nothing durable" rule. */
  emptyCase: string;
  /** Completes "one sentence describing …". */
  timelineNoun: string;
  /** Heading above the material itself. */
  heading: string;
}

function promptShapeFor(m: ItemMetadata): PromptShape {
  switch (m.kind) {
    case 'capture':
      return {
        preamble:
          'You are turning one fact a developer explicitly captured into durable vault entities.',
        facts: [
          `captured: ${m.capturedAt}`,
          `project: ${m.project ?? 'unknown'}`,
          `working directory: ${m.cwd ?? 'unknown'}`,
        ].join('\n'),
        emptyCase: 'A capture that records nothing durable',
        timelineNoun: 'what THIS capture records',
        heading: 'CAPTURED NOTE',
      };
    case 'artifact':
      return {
        preamble:
          "You are extracting durable engineering knowledge from a project's agent " +
          'instruction file — the standing rules and architecture a developer wrote ' +
          'for this repository.',
        facts: [`repository: ${m.repoPath}`, `file: ${m.file}`].join('\n'),
        emptyCase: 'An instruction file that establishes nothing durable',
        timelineNoun: 'what THIS file establishes',
        heading: 'INSTRUCTION FILE',
      };
    case 'session':
      return {
        preamble: 'You are extracting durable engineering knowledge from one coding session.',
        facts: [
          `session: ${m.sessionId}`,
          `project: ${m.projectPath ?? 'unknown'}`,
          `branch: ${m.gitBranch ?? 'unknown'}`,
          `started: ${m.startedAt ?? 'unknown'}`,
          `turns: ${String(m.promptCount)} prompts, ${String(m.proseCount)} replies`,
          `files touched: ${m.filesTouched.length > 0 ? m.filesTouched.join(', ') : 'none'}`,
          `outcome: ${m.terminalStatus}`,
        ].join('\n'),
        emptyCase: 'A session that decided nothing durable',
        timelineNoun: 'what THIS session did',
        heading: 'TRANSCRIPT',
      };
  }
}

/**
 * The extraction prompt.
 *
 * Deterministic facts are STATED, not requested. The model's job is prose and
 * aliases; asking it to restate a branch name it can already see is an
 * opportunity for it to get one wrong (spec §6).
 */
export function buildExtractionPrompt(
  item: DistilledItem,
  context?: ExtractionContext,
): string {
  const m = item.metadata;
  const shape = promptShapeFor(m);
  const { preamble, facts } = shape;

  const truncationNote = item.truncated
    ? '\nNOTE: this transcript was TRUNCATED to fit a size limit. You are seeing ' +
      'every user prompt but only the most recent assistant replies. Do not ' +
      'describe the session as if you saw all of it.\n'
    : '';

  // Naming an entity the vault already holds is how a second session UPDATES a
  // note instead of spawning a near-duplicate beside it. Resolution catches a
  // mismatch after the fact; this stops it happening as often to begin with.
  const existing =
    context && context.existingNames.length > 0
      ? `\nENTITIES ALREADY IN THIS VAULT — reuse one of these names EXACTLY when
you are describing the same thing, rather than inventing a variant:
${context.existingNames.map((n) => `- ${n}`).join('\n')}\n`
      : '';

  return `${preamble}

Return ONLY a JSON object matching this shape, with no commentary:

{"entities":[{"type":"Project"|"Subsystem"|"Topic","name":string,"aliases":[string],
"keywords":[string],"summary":string,"links":[{"target":string,"relation":string}],
"timelineEntry":string,"decisions":[{"date":"YYYY-MM-DD","text":string}],
"keyFacts":[string]}]}

Rules:
- Extract only what will still matter in six months. ${shape.emptyCase} should
  return {"entities":[]}.
- \`aliases\` and \`keywords\` are what make this searchable later. Include the
  literal identifiers a developer would type: file names, function names,
  flags, error strings. Prefer exact spellings over descriptions.
- \`summary\` is 2-3 sentences of plain prose.
- \`links.target\` names another entity, e.g. "Projects/omnifex".
- \`timelineEntry\` is one sentence describing ${shape.timelineNoun}.
- Use the facts below rather than inferring them.

FACTS
${facts}
${truncationNote}${existing}
${shape.heading}
${item.prose}`;
}

/**
 * One headless Haiku call per item, validated at the boundary.
 *
 * `BATCH_SIZE = 1`, adopted from Rowboat (spec §8): one item per call, so a
 * bad reply damages exactly one note and the retry is cheap.
 */
export function createExtractor(deps: ExtractorDeps = {}): Extractor {
  const runQuery = deps.runQuery ?? createSummaryQueryRunner();

  return async function extract(item, configDir, context) {
    const prompt = buildExtractionPrompt(item, context);
    const reply = await runQuery({ prompt, model: EXTRACTION_MODEL, configDir });
    try {
      return { ...parseExtraction(reply.result), run: runCostOf(reply) };
    } catch (err) {
      if (!(err instanceof ExtractionParseError)) throw err;
      // Exactly one retry (spec §8). A transport error never reaches here —
      // `runQuery` rejects and that propagates unretried, because a spawn or
      // auth failure is not a bad answer and immediately repeating it just
      // fails twice.
      const second = await runQuery({ prompt, model: EXTRACTION_MODEL, configDir });
      // Both calls are billed, so both are reported. The first one produced
      // garbage, not a refund.
      return {
        ...parseExtraction(second.result),
        run: addRunCosts(runCostOf(reply), runCostOf(second)),
      };
    }
  };
}
