import { z } from 'zod';
import { type CliRunResult } from '../sessions/summary-query';
import type { RunCost } from './sources/state';
import { addRunCosts } from './spend';
import type { DistilledItem, ItemMetadata } from './sources/types';

/** Model-supplied names are untrusted path input, and `vault.notePath` rejects separators. */
function lastNameSegment(name: string): string {
  return name.split(/[/\\]/).pop()?.trim() ?? '';
}

/** Optional collections default to `[]`: the merge is a pure fold and must not need `?? []`. */
const EntitySchema = z.object({
  type: z.enum(['Project', 'Subsystem', 'Topic']),
  name: z
    .string()
    .trim()
    .min(1)
    .transform(lastNameSegment)
    .refine((n) => n.length > 0, { error: 'name is empty after removing path segments' }),
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

export class ExtractionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionParseError';
  }
}

/** Counts depth and respects string literals: a greedy slice breaks on a brace in trailing prose. */
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

/** Throws, never returns null: retry-once must tell unusable from empty, and empty is a valid answer. */
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

/** A pinned family, never the account default (that would bill Opus). Not Haiku: it invented internals from a truncated tail. */
export const EXTRACTION_MODEL = 'sonnet';

export interface ExtractorDeps {
  /** Required, never defaulted: the daemon builds the shared runner. */
  runQuery: (
    opts: { prompt: string; model: string; configDir: string },
  ) => Promise<CliRunResult>;
}

export interface ExtractionContext {
  existingNames: string[];
}

/** `run` absent means nothing was spent; the state store then keeps prior figures. */
export type ExtractionRun = Extraction & { run?: RunCost };

export type Extractor = (
  item: DistilledItem,
  configDir: string,
  context?: ExtractionContext,
) => Promise<ExtractionRun>;

export function runCostOf(r: CliRunResult): RunCost {
  return {
    costUsd: r.costUsd,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheCreationTokens: r.cacheCreationTokens,
    model: r.model,
  };
}

/** Each kind states only what is true of it; the exhaustive switch makes a new kind a compile error. */
interface PromptShape {
  preamble: string;
  facts: string;
  emptyCase: string;
  timelineNoun: string;
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

/** Deterministic facts are stated, not requested: asking the model to restate them invites errors. */
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

/** One item per call: a bad reply damages one note and the retry is cheap. */
export function createExtractor(deps: ExtractorDeps): Extractor {
  const runQuery = deps.runQuery;

  return async function extract(item, configDir, context) {
    const prompt = buildExtractionPrompt(item, context);
    const reply = await runQuery({ prompt, model: EXTRACTION_MODEL, configDir });
    try {
      return { ...parseExtraction(reply.result), run: runCostOf(reply) };
    } catch (err) {
      if (!(err instanceof ExtractionParseError)) throw err;
      // One retry only. Transport errors propagate unretried: a spawn or auth failure is not a bad answer.
      const second = await runQuery({ prompt, model: EXTRACTION_MODEL, configDir });
      // Report both calls: the first was billed too.
      return {
        ...parseExtraction(second.result),
        run: addRunCosts(runCostOf(reply), runCostOf(second)),
      };
    }
  };
}
