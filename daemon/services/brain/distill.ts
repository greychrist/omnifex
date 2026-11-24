import type { DistilledItem, SessionMetadata } from './sources/types';
import { isRequestReplayLine } from '../util/request-replay';

export interface DistilledSession extends DistilledItem {
  metadata: { kind: 'session' } & SessionMetadata;
}

/**
 * The model never sees raw JSONL: tool results, file contents, diffs, thinking and attachments
 * are dropped entirely. Turns anchor on the user prompt. `isPromptRow` twins the prompt rule in
 * src/lib/jsonlClassifier.ts; change both.
 */

/** A safety rail above the observed maximum (~111 KB); a small cap made notes uninformative. */
export const DISTILL_MAX_CHARS = 131_072;

const TRUNCATION_MARKER = '[… earlier turns elided …]\n\n';

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

type Row = Record<string, unknown>;

function asRecord(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseLine(line: string): Row | null {
  if (!line.trim() || isRequestReplayLine(line)) return null;
  try {
    return asRecord(JSON.parse(line) as unknown);
  } catch {
    return null;
  }
}

function parseRows(jsonl: string): Row[] {
  const rows: Row[] = [];
  for (const line of jsonl.split('\n')) {
    const row = parseLine(line);
    if (row) rows.push(row);
  }
  return rows;
}

/** Yields the event loop every `sliceMs`: a long parse would freeze every live session. */
async function parseRowsAsync(jsonl: string, sliceMs: number): Promise<Row[]> {
  const rows: Row[] = [];
  let start = 0;
  let sliceStart = performance.now();
  while (start <= jsonl.length) {
    let end = jsonl.indexOf('\n', start);
    if (end === -1) end = jsonl.length;
    const row = parseLine(jsonl.slice(start, end));
    if (row) rows.push(row);
    start = end + 1;
    if (performance.now() - sliceStart >= sliceMs) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      sliceStart = performance.now();
    }
  }
  return rows;
}

/** Only observed tags: machine text in `user` rows was displacing real prompts from the budget. */
const SYNTHETIC_TAGS = 'task-notification|command-name|command-message|command-args|command-stdout|local-command-stdout';
const SYNTHETIC_BLOCK = new RegExp(`<(${SYNTHETIC_TAGS})>[\\s\\S]*?</\\1>`, 'g');
const SYNTHETIC_OPEN = new RegExp(`<(?:${SYNTHETIC_TAGS})>`);
const INTERRUPTION = /\[Request interrupted[^\]]*\]/g;

/** Strip blocks, not whole rows: the CLI can append a block to text the user typed. */
function cleanPrompt(text: string): string | null {
  const stripped = text.replace(SYNTHETIC_BLOCK, '').replace(INTERRUPTION, '').trim();
  if (!stripped) return null;
  // A leftover opening tag is malformed machine text; never let it through.
  if (SYNTHETIC_OPEN.test(stripped)) return null;
  return stripped;
}

function promptText(row: Row): string | null {
  const message = asRecord(row.message);
  if (!message) return null;
  const content = message.content;

  if (typeof content === 'string') return cleanPrompt(content);

  if (Array.isArray(content)) {
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

export function isPromptRow(row: Row): boolean {
  if (row.type !== 'user') return false;
  if (row.isMeta === true) return false;
  if (row.isSidechain === true) return false;
  if (row.isCompactSummary === true) return false;
  return promptText(row) !== null;
}

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
        if (b?.type !== 'tool_use') continue;
        const name = asString(b.name);
        if (!name || !FILE_TOOLS.has(name)) continue;
        const input = asRecord(b.input);
        const filePath = input ? asString(input.file_path) : null;
        // The path, never the content: a file body reaching a note is a leak.
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

/** Prompts get the budget first, then replies; oldest dropped first within each; output stays in transcript order. */
function truncateWithPromptPriority(chunks: Chunk[]): { prose: string; truncated: boolean } {
  const joined = chunks.map((c) => c.text).join('\n\n');
  if (joined.length <= DISTILL_MAX_CHARS) return { prose: joined, truncated: false };

  const budget = DISTILL_MAX_CHARS - TRUNCATION_MARKER.length;
  const keep = new Set<number>();
  let used = 0;

  // `continue`, not `break`: one oversized chunk must not drop every smaller one after it.
  for (const kind of ['prompt', 'prose'] as const) {
    for (let i = chunks.length - 1; i >= 0; i -= 1) {
      if (chunks[i].kind !== kind) continue;
      const cost = chunks[i].text.length + (keep.size > 0 ? 2 : 0);
      if (used + cost > budget) continue;
      keep.add(i);
      used += cost;
    }
  }

  // One chunk larger than the whole budget must still yield something.
  if (keep.size === 0) {
    return {
      prose: TRUNCATION_MARKER + chunks[chunks.length - 1].text.slice(-budget),
      truncated: true,
    };
  }

  const kept = chunks.filter((_, i) => keep.has(i)).map((c) => c.text);
  return { prose: TRUNCATION_MARKER + kept.join('\n\n'), truncated: true };
}

/** `sessionId` comes from the filename, never the rows: a transcript must not rename itself. */
export function distillTranscript(jsonl: string, sessionId: string): DistilledSession {
  return distillRows(parseRows(jsonl), sessionId);
}

export async function distillTranscriptAsync(
  jsonl: string,
  sessionId: string,
  opts: { sliceMs?: number } = {},
): Promise<DistilledSession> {
  return distillRows(await parseRowsAsync(jsonl, opts.sliceMs ?? 10), sessionId);
}

function distillRows(rows: Row[], sessionId: string): DistilledSession {
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
