import { z } from 'zod';
import { type CliRunResult } from '../sessions/summary-query';
import type { CurationResult } from './curate';
import { firstJsonObject, runCostOf } from './extract';
import { addRunCosts } from './spend';
import type { RunCost } from './sources/state';

/** Both prose fields empty is a parse failure: it would collapse spans and put nothing in their place. */
const CurationResultSchema = z
  .object({
    collapsed: z.string().trim().default(''),
    collapsedDecisions: z.string().trim().default(''),
    promotedFacts: z.array(z.string()).default([]),
  })
  .refine((r) => r.collapsed !== '' || r.collapsedDecisions !== '', {
    error: 'expected prose for at least one collapsed span',
    path: ['collapsed'],
  });


export class CurationParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurationParseError';
  }
}

/** Pinned separately from EXTRACTION_MODEL: different volume, different stakes. */
export const CURATION_MODEL = 'opus';

/** `entries` and `decisions` must be exactly what the fold removes, never a superset. */
export interface CurationInput {
  title: string;
  noteType: string;
  entries: string[];
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
  // Returning the parsed value as CurationResult is the compile-time check that schema and fold agree.
  return result.data;
}

export function buildCurationPrompt(input: CurationInput): string {
  const decisions = input.decisions ?? [];
  // Omit empty sections: asking to summarize an absent span invites invention.
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

/** `run` absent means nothing was spent, not free. */
export type CurationRun = CurationResult & { run?: RunCost };

export type Curator = (input: CurationInput, configDir: string) => Promise<CurationRun>;

export interface CuratorDeps {
  /** The runner's scratch cwd is excluded from Brain discovery, so curation calls are never re-indexed. */
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
      // One retry only. Transport errors propagate unretried: a spawn or auth failure is not a bad answer.
      const second = await runQuery({ prompt, model: CURATION_MODEL, configDir });
      // Report both legs: the first call was paid for.
      return {
        ...parseCuration(second.result),
        run: addRunCosts(runCostOf(reply), runCostOf(second)),
      };
    }
  };
}
