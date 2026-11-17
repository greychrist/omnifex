// Cost module — deduped usage extraction from a session JSONL.
//
// The CLI writes one JSONL line per assistant content block; lines belonging
// to the same API request share `requestId` (and `message.id`) and carry the
// SAME usage object, so summing raw lines double-counts multi-block messages.
// This extractor keys rows by requestId (fallback message.id, fallback line
// index) with last-occurrence-wins semantics, yielding exactly one usage row
// per billed API request.

import type { UsageTokens } from '../../../src/lib/pricing';

export interface ExtractedUsageRow {
  key: string;
  model: string;
  timestamp: string;
  usage: UsageTokens;
}

/**
 * A transcript's deduped usage as a fold over its lines, so a reader that has
 * seen a file up to some line can continue from there instead of re-reading
 * it. Feeding a transcript in any number of pieces gives exactly what
 * `extractDedupedUsage` gives for the whole of it.
 */
export interface UsageFold {
  /** Rows by key, in order of each key's last observation. */
  rows: Map<string, ExtractedUsageRow>;
  /** Complete lines consumed: the next line's number is `lineNo + 1`. */
  lineNo: number;
  /** The first absolute `cwd` among the first 50 lines, or null. */
  cwd: string | null;
}

/** How many leading lines may name the session's working directory. */
const CWD_LINES = 50;

export function newUsageFold(): UsageFold {
  return { rows: new Map(), lineNo: 0, cwd: null };
}

function foldLine(fold: UsageFold, rawLine: string, lineNo: number): void {
  const trimmed = rawLine.trim();
  if (!trimmed) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) return;
  const obj = parsed as {
    type?: unknown;
    cwd?: unknown;
    requestId?: unknown;
    timestamp?: unknown;
    message?: { id?: unknown; model?: unknown; usage?: UsageTokens };
  };
  if (fold.cwd === null && lineNo <= CWD_LINES && typeof obj.cwd === 'string' && obj.cwd.startsWith('/')) {
    fold.cwd = obj.cwd;
  }
  if (obj.type !== 'assistant') return;
  const usage = obj.message?.usage;
  if (!usage) return;
  const key =
    (typeof obj.requestId === 'string' && obj.requestId) ||
    (typeof obj.message?.id === 'string' && obj.message.id) ||
    `line:${lineNo}`;
  // Delete-then-set so a re-observed key moves to the end (last wins, and
  // iteration order stays chronological with respect to final observations).
  if (fold.rows.has(key)) fold.rows.delete(key);
  fold.rows.set(key, {
    key,
    model: typeof obj.message?.model === 'string' && obj.message.model ? obj.message.model : 'unknown',
    timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : '',
    usage,
  });
}

/**
 * Fold `text`, which starts at the beginning of line `fold.lineNo + 1`. Every
 * piece between newlines is a line. With `tailIsPartial` the last piece is a
 * line that may still be being written: it is folded — a file without a final
 * newline is complete as far as anyone can tell — but not counted, and the
 * caller passes it again, from its start, with whatever follows it. Folding a
 * line twice changes nothing: its key is the same, and last wins.
 */
export function foldUsage(fold: UsageFold, text: string, opts: { tailIsPartial: boolean }): void {
  const lines = text.split('\n');
  const complete = opts.tailIsPartial ? lines.length - 1 : lines.length;
  for (let i = 0; i < complete; i += 1) foldLine(fold, lines[i], fold.lineNo + i + 1);
  if (opts.tailIsPartial) foldLine(fold, lines[lines.length - 1], fold.lineNo + complete + 1);
  fold.lineNo += complete;
}

export function extractDedupedUsage(content: string): ExtractedUsageRow[] {
  const fold = newUsageFold();
  foldUsage(fold, content, { tailIsPartial: true });
  return [...fold.rows.values()];
}

export interface SubagentUsage {
  agentId: string;
  rows: ExtractedUsageRow[];
}

/**
 * One session's billed requests across its main transcript and every
 * subagent transcript, each request counted once.
 *
 * Deduping per file is not enough: a fork subagent's transcript opens with a
 * copy of the parent's assistant record that made the Agent call — same
 * `requestId`, full `usage` (CLI 2.1.302, when forks reached `-p` sessions).
 * The main loop owns any request it holds; otherwise the first subagent file
 * to hold it does. Line-number fallback keys are file-local and never match
 * across files.
 */
export function extractSessionUsage(
  sessionContent: string,
  subagentFiles: readonly { agentId: string; content: string }[],
): { main: ExtractedUsageRow[]; subagents: SubagentUsage[] } {
  return claimSessionUsage(
    extractDedupedUsage(sessionContent),
    subagentFiles.map((file) => ({ agentId: file.agentId, rows: extractDedupedUsage(file.content) })),
  );
}

/** The cross-file half of `extractSessionUsage`, over rows already deduped
 *  per file — what an incremental reader holds. */
export function claimSessionUsage(
  main: ExtractedUsageRow[],
  subagentFiles: readonly SubagentUsage[],
): { main: ExtractedUsageRow[]; subagents: SubagentUsage[] } {
  const claimed = new Set(main.map((r) => r.key));
  const subagents = subagentFiles.map((file) => {
    const rows = file.rows.filter((r) => r.key.startsWith('line:') || !claimed.has(r.key));
    for (const r of rows) claimed.add(r.key);
    return { agentId: file.agentId, rows };
  });
  return { main, subagents };
}
