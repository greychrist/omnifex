// The CLI writes one line per content block, all with the request's usage: summing raw lines double-counts. Last wins.

import type { UsageTokens } from '../../../src/lib/pricing';

export interface ExtractedUsageRow {
  key: string;
  model: string;
  timestamp: string;
  usage: UsageTokens;
}

/** Folding in any number of pieces must equal `extractDedupedUsage` over the whole. */
export interface UsageFold {
  rows: Map<string, ExtractedUsageRow>;
  lineNo: number;
  cwd: string | null;
}

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
  // Delete-then-set keeps iteration in order of final observation.
  if (fold.rows.has(key)) fold.rows.delete(key);
  fold.rows.set(key, {
    key,
    model: typeof obj.message?.model === 'string' && obj.message.model ? obj.message.model : 'unknown',
    timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : '',
    usage,
  });
}

/** A partial tail is folded but not counted; the caller re-feeds it. Refolding a line changes nothing (last wins). */
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
 * A fork subagent's transcript opens with a copy of the parent's Agent-call record (same requestId), so dedupe
 * across files: the main loop owns any request it holds. Line-number keys are file-local.
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
