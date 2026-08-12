import type { DistilledItem, SessionMetadata } from './sources/types';

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
 * ~8KB per session (spec §6). Characters rather than tokens: the ceiling is a
 * budget guard, and a tokenizer here would be precision nobody consumes.
 */
export const DISTILL_MAX_CHARS = 8_192;

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
function cleanPrompt(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^<command-(name|stdout|args|message)>/.test(trimmed)) return null;
  return trimmed;
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

/**
 * Trim to the ceiling by dropping the OLDEST turns, marking what happened.
 *
 * Oldest-first rather than head+tail (which is what `sessions-summary.ts` does
 * for a different contract): a session's conclusions live at its end, and
 * those are what a memory note is for. The marker is not decoration — a reader
 * with no marker narrates a tail as if it were the whole session.
 */
function truncateOldestFirst(chunks: string[]): { prose: string; truncated: boolean } {
  const joined = chunks.join('\n\n');
  if (joined.length <= DISTILL_MAX_CHARS) return { prose: joined, truncated: false };

  const budget = DISTILL_MAX_CHARS - TRUNCATION_MARKER.length;
  const kept: string[] = [];
  let used = 0;
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const cost = chunks[i].length + (kept.length > 0 ? 2 : 0);
    if (used + cost > budget) break;
    kept.unshift(chunks[i]);
    used += cost;
  }
  // A single chunk larger than the whole budget still has to yield something,
  // or a session with one enormous prompt distills to nothing but a marker.
  if (kept.length === 0) kept.push(chunks[chunks.length - 1].slice(-budget));
  return { prose: TRUNCATION_MARKER + kept.join('\n\n'), truncated: true };
}

/**
 * Reduce one session transcript to what a model may see.
 *
 * `sessionId` is passed in rather than read from the rows: the file's name is
 * the authority on which session it is, and a transcript whose rows disagree
 * with its filename should not get to rename itself.
 */
export function distillTranscript(jsonl: string, sessionId: string): DistilledItem {
  const rows = parseRows(jsonl);
  const chunks: string[] = [];

  for (const row of rows) {
    const prompt = isPromptRow(row) ? promptText(row) : null;
    if (prompt) {
      chunks.push(`USER: ${prompt}`);
      continue;
    }
    const prose = assistantProse(row);
    if (prose) chunks.push(`ASSISTANT: ${prose}`);
  }

  const { prose, truncated } = truncateOldestFirst(chunks);
  return { prose, metadata: collectMetadata(rows, sessionId), truncated };
}
