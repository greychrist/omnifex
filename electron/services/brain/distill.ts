import type { DistilledItem, SessionMetadata } from './sources/types';

/**
 * A distillation that is definitely a session.
 *
 * `DistilledItem.metadata` is a union, but everything this module produces is
 * a session — so callers get the session fields without narrowing, and the
 * narrowing that WOULD be needed is a branch that could never be taken.
 */
export interface DistilledSession extends DistilledItem {
  metadata: { kind: 'session' } & SessionMetadata;
}

/**
 * JSONL transcript → bounded prose plus structured metadata.
 *
 * Pure: text in, values out. No filesystem, no account awareness, no model.
 * That is what makes the spec's heaviest test requirements cheap to satisfy.
 *
 * Two rules govern everything here, both from spec §6:
 *
 *   1. The model must never see raw JSONL. Prompts, assistant prose and
 *      outcomes are kept; tool results, file contents, diffs, thinking and
 *      attachments are dropped ENTIRELY — not summarised, not truncated.
 *      A note built from this text can be read back into a future prompt, so
 *      anything that leaks in here leaks twice.
 *   2. Turns anchor on the user PROMPT, never on assistant-message adjacency,
 *      which miscounts any turn containing subagents. Same rule, same reason
 *      as `src/lib/turnDelta.ts`.
 *
 * Why this does not import the renderer's classifier: `src/lib/jsonlClassifier.ts`
 * is the authoritative version of the prompt rule, but it imports `@/types/jsonl`
 * and `tsconfig.electron.json` defines no `paths` alias, so importing it fails
 * `npm run check`. `isPromptRow` below is its narrow twin, in the same
 * across-the-process-boundary arrangement as `electron/services/brain/links.ts`
 * and `src/lib/brainWikilinks.ts`. If the CLI changes how a prompt row is
 * marked, BOTH need updating.
 */

/**
 * 128KB per session. Characters rather than tokens: the ceiling is a budget
 * guard, and a tokenizer here would be precision nobody consumes.
 *
 * Spec §6 said 8KB, and that was measured wrong. Distillation already drops
 * tool results, thinking blocks, file contents and (now) machine-generated
 * blocks, so the surviving prose is a tiny fraction of the raw JSONL: measured
 * across the personal account's 64 admitted sessions, the full distilled size
 * is a median of 27KB and a MAXIMUM of 111.5KB — against raw transcripts of
 * 5-21MB. At 8KB only 11 of 64 sessions survived whole and 78% of the material
 * was discarded; every large session was cut to the same 8KB stub, which is
 * what made the notes uninformative.
 *
 * 128KB is the smallest round cap above that observed maximum, so on this
 * corpus nothing is truncated at all and 256KB would buy nothing. The cap is
 * now a safety rail against a pathological outlier rather than a routine
 * constraint — and because it binds only on outliers, the cost per extraction
 * is the session's real size (~27KB median), not the cap.
 */
export const DISTILL_MAX_CHARS = 131_072;

const TRUNCATION_MARKER = '[… earlier turns elided …]\n\n';

/** Tools whose `input.file_path` names a file the session touched. */
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

type Row = Record<string, unknown>;

function asRecord(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Parse leniently: a malformed line is skipped, never thrown. */
function parseRows(jsonl: string): Row[] {
  const rows: Row[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = asRecord(JSON.parse(line) as unknown);
      if (row) rows.push(row);
    } catch {
      // A truncated final line is normal for a session still being written.
    }
  }
  return rows;
}

/**
 * Drop the slash-command wrapper tags the CLI injects around a prelude
 * (`<command-name>`, `<command-stdout>`, …). Matching `sessions-summary.ts`'s
 * filter: these are machine text, and a note quoting them reads as if the user
 * typed XML.
 */
/**
 * Machine-generated blocks the CLI writes into rows typed `user`.
 *
 * Measured on the real corpus (2026-08-12): across the 25 largest transcripts,
 * 107 of 576 candidate prompt rows — 19% — were pure `<task-notification>`
 * payloads, and on two sessions machine text made up 45-47% of the ENTIRE
 * distillation. Because `truncateWithPromptPriority` spends the budget on
 * prompts FIRST, this noise was displacing the real asks it exists to protect.
 *
 * Only tags actually observed are listed. `<system-reminder>` is deliberately
 * absent: it never appeared in a candidate prompt row on this corpus, and
 * filtering for something unobserved is a guess wearing a rule's clothes.
 */
const SYNTHETIC_TAGS = 'task-notification|command-name|command-message|command-args|command-stdout|local-command-stdout';
const SYNTHETIC_BLOCK = new RegExp(`<(${SYNTHETIC_TAGS})>[\\s\\S]*?</\\1>`, 'g');
const SYNTHETIC_OPEN = new RegExp(`<(?:${SYNTHETIC_TAGS})>`);
/** The CLI's own marker, not something the user typed. */
const INTERRUPTION = /\[Request interrupted[^\]]*\]/g;

/**
 * Strip machine blocks and keep whatever the human actually typed.
 *
 * Stripping BLOCKS rather than dropping whole rows: every one of the 107
 * observed notification rows was pure machine text, so in practice this drops
 * them — but the CLI can append a block to text the user really typed, and a
 * whole-row rule would throw the ask away with the noise.
 */
function cleanPrompt(text: string): string | null {
  const stripped = text.replace(SYNTHETIC_BLOCK, '').replace(INTERRUPTION, '').trim();
  if (!stripped) return null;
  // A leftover opening tag means the block was malformed. It is machine text
  // either way, and letting it through would leak the payload this removes.
  if (SYNTHETIC_OPEN.test(stripped)) return null;
  return stripped;
}

/** The typed text of a prompt row, or null when the row carries none. */
function promptText(row: Row): string | null {
  const message = asRecord(row.message);
  if (!message) return null;
  const content = message.content;

  if (typeof content === 'string') return cleanPrompt(content);

  if (Array.isArray(content)) {
    // Any `tool_result` block disqualifies the row: that is tool output
    // wearing a user-row costume, and it is exactly the bulk this function
    // exists to keep out.
    if (content.some((b) => asRecord(b)?.type === 'tool_result')) return null;
    const text = content
      .map((b) => asRecord(b))
      .filter((b): b is Row => b !== null && b.type === 'text')
      .map((b) => asString(b.text))
      .filter((t): t is string => t !== null)
      .join('\n');
    return cleanPrompt(text);
  }

  return null;
}

/**
 * True for a row that is a HUMAN prompt.
 *
 * The exclusions are all rows the CLI also types as `user`:
 *  - tool results (they ride on user-type rows whose content blocks are
 *    `tool_result`)
 *  - `isMeta` rows: skill injections, attachment markers, slash-command
 *    preludes — machine text the user never typed
 *  - compaction summaries (`isCompactSummary`, or `isReplay === false`),
 *    which are the CLI replaying its own text back into the transcript
 *  - sidechain rows, which belong to a subagent's conversation, not the
 *    user's
 */
export function isPromptRow(row: Row): boolean {
  if (row.type !== 'user') return false;
  if (row.isMeta === true) return false;
  if (row.isSidechain === true) return false;
  if (row.isCompactSummary === true) return false;
  // Strict `=== false`: a live prompt omits isReplay entirely, and `undefined`
  // must not read as "not a replay, therefore a summary".
  if (row.isReplay === false) return false;
  return promptText(row) !== null;
}

/** Assistant PROSE only — no tool_use, no thinking, no redacted blocks. */
function assistantProse(row: Row): string | null {
  if (row.type !== 'assistant') return null;
  if (row.isSidechain === true) return null;
  const message = asRecord(row.message);
  if (!message || !Array.isArray(message.content)) return null;
  const text = message.content
    .map((b) => asRecord(b))
    .filter((b): b is Row => b !== null && b.type === 'text')
    .map((b) => asString(b.text))
    .filter((t): t is string => t !== null)
    .join('\n')
    .trim();
  return text.length > 0 ? text : null;
}

function collectMetadata(rows: Row[], sessionId: string): SessionMetadata {
  let projectPath: string | null = null;
  let gitBranch: string | null = null;
  let cliVersion: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let promptCount = 0;
  let proseCount = 0;
  let sawApiError = false;
  const models: string[] = [];
  const filesTouched: string[] = [];

  for (const row of rows) {
    const ts = asString(row.timestamp);
    if (ts) {
      if (!startedAt) startedAt = ts;
      endedAt = ts;
    }
    // First-seen wins for the session-wide facts: the CLI stamps these on most
    // rows, and a session that changed directory mid-run is still the session
    // that STARTED where it started.
    projectPath ??= asString(row.cwd);
    gitBranch ??= asString(row.gitBranch);
    cliVersion ??= asString(row.version);

    if (row.isApiErrorMessage === true) sawApiError = true;
    if (isPromptRow(row)) promptCount += 1;
    if (assistantProse(row) !== null) proseCount += 1;

    const message = asRecord(row.message);
    const model = message ? asString(message.model) : null;
    if (model && !models.includes(model)) models.push(model);

    if (message && Array.isArray(message.content)) {
      for (const block of message.content) {
        const b = asRecord(block);
        if (!b || b.type !== 'tool_use') continue;
        const name = asString(b.name);
        if (!name || !FILE_TOOLS.has(name)) continue;
        const input = asRecord(b.input);
        const filePath = input ? asString(input.file_path) : null;
        // The PATH, never the input's `content` / `new_string`. A file body
        // reaching a note is the same leak as a tool result reaching prose.
        if (filePath && !filesTouched.includes(filePath)) filesTouched.push(filePath);
      }
    }
  }

  const durationMs = startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : null;

  return {
    sessionId,
    projectPath,
    gitBranch,
    models,
    cliVersion,
    startedAt,
    endedAt,
    durationMs: durationMs !== null && Number.isFinite(durationMs) ? durationMs : null,
    promptCount,
    proseCount,
    filesTouched,
    terminalStatus: rows.length === 0 ? 'unknown' : sawApiError ? 'error' : 'completed',
  };
}

interface Chunk {
  kind: 'prompt' | 'prose';
  text: string;
}

/**
 * Trim to the ceiling, sacrificing assistant replies before user prompts.
 *
 * Spec §6 says oldest-first, and this keeps that ordering WITHIN each kind.
 * But it spends the budget on prompts first, because the measured behaviour of
 * plain oldest-first on this corpus was that it dropped every prompt: the
 * median admitted transcript is 1.4MB against an 8KB ceiling, and assistant
 * prose outweighs prompts by roughly 9:1. A note recording what was said
 * without what was asked is the weaker half of the session.
 *
 * "Keep every prompt" is a PRIORITY, not an exemption. When the prompts alone
 * exceed the budget they are themselves dropped oldest-first, because the
 * ceiling is what makes extraction cost predictable.
 *
 * Output is always in transcript order. Reordering would make the prose read
 * as a different conversation than the one that happened.
 *
 * Head+tail (what `sessions-summary.ts` does) is a different contract for a
 * different consumer and deliberately not shared.
 */
function truncateWithPromptPriority(chunks: Chunk[]): { prose: string; truncated: boolean } {
  const joined = chunks.map((c) => c.text).join('\n\n');
  if (joined.length <= DISTILL_MAX_CHARS) return { prose: joined, truncated: false };

  const budget = DISTILL_MAX_CHARS - TRUNCATION_MARKER.length;
  const keep = new Set<number>();
  let used = 0;

  // Pass 1 takes prompts, newest-first so the most recent survive a
  // prompt-only overflow; pass 2 fills what is left with replies.
  //
  // `continue` rather than `break`: a chunk too large to fit must not stop
  // smaller later ones from being considered, or one long reply near the start
  // silently costs every reply after it.
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

/**
 * Reduce one session transcript to what a model may see.
 *
 * `sessionId` is passed in rather than read from the rows: the file's name is
 * the authority on which session it is, and a transcript whose rows disagree
 * with its filename should not get to rename itself.
 */
export function distillTranscript(jsonl: string, sessionId: string): DistilledSession {
  const rows = parseRows(jsonl);
  const chunks: Chunk[] = [];

  for (const row of rows) {
    const prompt = isPromptRow(row) ? promptText(row) : null;
    if (prompt) {
      chunks.push({ kind: 'prompt', text: `USER: ${prompt}` });
      continue;
    }
    const prose = assistantProse(row);
    if (prose) chunks.push({ kind: 'prose', text: `ASSISTANT: ${prose}` });
  }

  const { prose, truncated } = truncateWithPromptPriority(chunks);
  return {
    prose,
    metadata: { kind: 'session', ...collectMetadata(rows, sessionId) },
    truncated,
  };
}
