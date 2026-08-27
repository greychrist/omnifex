import { z } from 'zod';
import { type CliRunResult } from '../sessions/summary-query';
import type { CurationResult } from './curate';
import { firstJsonObject, runCostOf } from './extract';
import { addRunCosts } from './spend';
import type { RunCost } from './sources/state';

/**
 * The curation contract (spec §3). `extract.ts`'s twin: schema, prompt, pinned
 * model, retry-once runner.
 */

/**
 * Neither prose field is individually required, because a note qualifying on
 * one section alone is shown one block and has nothing to say about the other.
 * A reply with BOTH empty is still a parse failure: it would collapse spans and
 * put nothing in their place, which is the one outcome worse than not curating.
 */
const CurationResultSchema = z
  .object({
    collapsed: z.string().trim().default(''),
    collapsedDecisions: z.string().trim().default(''),
    promotedFacts: z.array(z.string()).default([]),
  })
  .refine((r) => r.collapsed !== '' || r.collapsedDecisions !== '', {
    message: 'expected prose for at least one collapsed span',
    path: ['collapsed'],
  });

/**
 * Compile-time proof that the schema and the pure fold's input agree.
 *
 * `CurationResult` is declared in `curate.ts` so the fold never imports this
 * module; this assignment is what stops the two drifting apart silently.
 */
const _shapeCheck: (a: z.infer<typeof CurationResultSchema>) => CurationResult = (a) => a;
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

/**
 * What the model is shown. `entries` and `decisions` are exactly what the fold
 * will remove — never a superset, never a differently-computed span.
 */
export interface CurationInput {
  title: string;
  noteType: string;
  entries: string[];
  /** Dated `Decisions` bullets being collapsed. Empty when none are. */
  decisions?: string[];
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
 * withheld prose for entries the fold is going to remove anyway would leave
 * the note strictly worse off.
 */
export function buildCurationPrompt(input: CurationInput): string {
  const decisions = input.decisions ?? [];
  // A section with nothing to collapse is omitted entirely rather than shown
  // empty. Asking for a summary of an absent span invites the model to invent
  // one, and its prose would then be folded in beside a computed date range.
  const blocks = [
    input.entries.length > 0 ? `TIMELINE ENTRIES BEING COLLAPSED\n${input.entries.join('\n')}` : '',
    decisions.length > 0 ? `DECISIONS BEING COLLAPSED\n${decisions.join('\n')}` : '',
  ].filter((block) => block !== '');

  return `You are compressing one note in an engineering knowledge vault, so that
retrieving the note costs less context.

Return ONLY a JSON object matching this shape, with no commentary:

{"collapsed":string,"collapsedDecisions":string,"promotedFacts":[string]}

Rules:
- \`collapsed\` covers the TIMELINE entries below. \`collapsedDecisions\` covers
  the DECISIONS below. Each is 1-3 sentences of plain prose covering that block
  as a whole, and replaces it. Write what a developer would still need in six
  months: what was decided, what changed, what it led to.
- If a block is absent below, return "" for its field. Do not invent one.
- \`promotedFacts\` are durable facts that recur across these entries and are
  worth keeping as standalone facts once the entries are gone. Return [] if
  there are none. Do not restate the prose.
- Write plain sentences. No Markdown headings, no bullets, no line breaks.
- These entries have already been selected for collapsing. Your job is to
  summarize them, not to choose which ones survive.

NOTE
${input.noteType}: ${input.title}

${blocks.join('\n\n')}`;
}

/**
 * A curation, plus what producing it cost.
 *
 * Mirrors `ExtractionRun` deliberately. Curation is pinned to Opus, so it is
 * the most expensive thing the Brain does — and before Plan 8 the runner
 * discarded the cost half of the CLI envelope, which made the single largest
 * line item the one nothing could report.
 *
 * Optional for the same reason extraction's is: a test curator spends nothing,
 * and absent must mean "nothing was spent" rather than "it was free".
 */
export type CurationRun = CurationResult & { run?: RunCost };

export type Curator = (input: CurationInput, configDir: string) => Promise<CurationRun>;

export interface CuratorDeps {
  /**
   * Injected in tests. Defaults to the shared `claude -p` runner, which
   * already pins a stable scratch cwd and sweeps the throwaway JSONL the CLI
   * writes — and the Brain's own discovery excludes that scratch directory, so
   * curation calls cannot be re-indexed by the Brain.
   */
  runQuery: (
    opts: { prompt: string; model: string; configDir: string },
  ) => Promise<CliRunResult>;
}

export function createCurator(deps: CuratorDeps): Curator {
  const runQuery = deps.runQuery;

  return async function curateWithModel(input, configDir) {
    const prompt = buildCurationPrompt(input);
    const reply = await runQuery({ prompt, model: CURATION_MODEL, configDir });
    try {
      return { ...parseCuration(reply.result), run: runCostOf(reply) };
    } catch (err) {
      if (!(err instanceof CurationParseError)) throw err;
      // Exactly one retry, matching `createExtractor`. A transport error never
      // reaches here — `runQuery` rejects and that propagates unretried,
      // because a spawn or auth failure is not a bad answer and immediately
      // repeating it just fails twice.
      const second = await runQuery({ prompt, model: CURATION_MODEL, configDir });
      // Both legs, not just the one that worked: the first call was paid for.
      return {
        ...parseCuration(second.result),
        run: addRunCosts(runCostOf(reply), runCostOf(second)),
      };
    }
  };
}
