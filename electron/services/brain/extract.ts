import { z } from 'zod';
import { createSummaryQueryRunner } from '../sessions/summary-query';
import type { DistilledItem } from './sources/types';

/**
 * The extraction contract (spec §8).
 *
 * Optional collections default to `[]` rather than being left undefined: the
 * merge is a pure fold over these, and every `?? []` it would otherwise need
 * is a place a future edit forgets one.
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
 * Pinned, not configurable (spec §8). Extraction is a high-volume,
 * low-judgement task, and letting it inherit an account's session default
 * would quietly bill Opus for it.
 */
export const EXTRACTION_MODEL = 'claude-haiku-4-5';

export interface ExtractorDeps {
  /**
   * Injected in tests. Defaults to the shared `claude -p` runner, which
   * already pins a stable scratch cwd and sweeps the throwaway JSONL the CLI
   * writes — and the Brain's own discovery excludes that scratch directory, so
   * extraction calls cannot be re-indexed by the Brain.
   */
  runQuery?: (opts: { prompt: string; model: string; configDir: string }) => Promise<string>;
}

export type Extractor = (item: DistilledItem, configDir: string) => Promise<Extraction>;

/**
 * The extraction prompt.
 *
 * Deterministic facts are STATED, not requested. The model's job is prose and
 * aliases; asking it to restate a branch name it can already see is an
 * opportunity for it to get one wrong (spec §6).
 */
export function buildExtractionPrompt(item: DistilledItem): string {
  const m = item.metadata;
  const facts = [
    `session: ${m.sessionId}`,
    `project: ${m.projectPath ?? 'unknown'}`,
    `branch: ${m.gitBranch ?? 'unknown'}`,
    `started: ${m.startedAt ?? 'unknown'}`,
    `turns: ${String(m.promptCount)} prompts, ${String(m.proseCount)} replies`,
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

/**
 * One headless Haiku call per item, validated at the boundary.
 *
 * `BATCH_SIZE = 1`, adopted from Rowboat (spec §8): one item per call, so a
 * bad reply damages exactly one note and the retry is cheap.
 */
export function createExtractor(deps: ExtractorDeps = {}): Extractor {
  const runQuery = deps.runQuery ?? createSummaryQueryRunner();

  return async function extract(item, configDir) {
    const prompt = buildExtractionPrompt(item);
    const reply = await runQuery({ prompt, model: EXTRACTION_MODEL, configDir });
    try {
      return parseExtraction(reply);
    } catch (err) {
      if (!(err instanceof ExtractionParseError)) throw err;
      // Exactly one retry (spec §8). A transport error never reaches here —
      // `runQuery` rejects and that propagates unretried, because a spawn or
      // auth failure is not a bad answer and immediately repeating it just
      // fails twice.
      const second = await runQuery({ prompt, model: EXTRACTION_MODEL, configDir });
      return parseExtraction(second);
    }
  };
}
