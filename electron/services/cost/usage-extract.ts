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

export function extractDedupedUsage(content: string): ExtractedUsageRow[] {
  const map = new Map<string, ExtractedUsageRow>();
  let lineNo = 0;
  for (const rawLine of content.split('\n')) {
    lineNo += 1;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const obj = parsed as {
      type?: unknown;
      requestId?: unknown;
      timestamp?: unknown;
      message?: { id?: unknown; model?: unknown; usage?: UsageTokens };
    };
    if (obj.type !== 'assistant') continue;
    const usage = obj.message?.usage;
    if (!usage) continue;
    const key =
      (typeof obj.requestId === 'string' && obj.requestId) ||
      (typeof obj.message?.id === 'string' && obj.message.id) ||
      `line:${lineNo}`;
    // Delete-then-set so a re-observed key moves to the end (last wins, and
    // iteration order stays chronological with respect to final observations).
    if (map.has(key)) map.delete(key);
    map.set(key, {
      key,
      model: typeof obj.message?.model === 'string' && obj.message.model ? obj.message.model : 'unknown',
      timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : '',
      usage,
    });
  }
  return [...map.values()];
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
  const main = extractDedupedUsage(sessionContent);
  const claimed = new Set(main.map((r) => r.key));
  const subagents = subagentFiles.map((file) => {
    const rows = extractDedupedUsage(file.content).filter((r) => r.key.startsWith('line:') || !claimed.has(r.key));
    for (const r of rows) claimed.add(r.key);
    return { agentId: file.agentId, rows };
  });
  return { main, subagents };
}
