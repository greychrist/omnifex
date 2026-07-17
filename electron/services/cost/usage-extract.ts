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
