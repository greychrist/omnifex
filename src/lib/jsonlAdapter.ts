import type { JsonlNode } from '@/types/jsonl';
import type { ClaudeStreamMessage } from '@/types/claudeStream';

/**
 * Translate a JsonlNode into the renderer's existing ClaudeStreamMessage
 * shape. Most nodes are pass-throughs (their `raw` IS a ClaudeStreamMessage
 * shape). Synthesized nodes produce the equivalent shapes the SDK iterator
 * would have emitted, so downstream consumers don't need to know whether
 * the message is real or synthesized.
 *
 * Returns null for overlay kinds (stream-event / rate-limit / lifecycle) —
 * those never enter messages[].
 */
export function jsonlNodeToStreamMessage(node: JsonlNode): ClaudeStreamMessage | null {
  switch (node.kind) {
    case 'assistant':
    case 'user':
    case 'attachment':
    case 'queue-operation':
    case 'last-prompt':
    case 'permission-mode':
    case 'ai-title':
    case 'file-history-snapshot':
    case 'system': {
      const raw = (node as { raw: unknown }).raw as ClaudeStreamMessage;
      if ('receivedAt' in node && node.receivedAt) {
        (raw as { receivedAt?: string }).receivedAt = node.receivedAt;
      }
      return raw;
    }
    case 'synthesized-init': {
      return {
        type: 'system',
        subtype: 'init',
        session_id: node.sessionId,
        cwd: node.cwd,
        receivedAt: node.receivedAt,
        synthesized: true,
      } as unknown as ClaudeStreamMessage;
    }
    case 'synthesized-result': {
      return {
        type: 'result',
        subtype: node.subtype,
        is_error: node.isError,
        result: node.body,
        duration_ms: node.durationMs,
        duration_api_ms: 0,
        num_turns: 0,
        stop_reason: node.stopReason,
        total_cost_usd: node.totalCostUsd,
        usage: node.usage,
        modelUsage: {},
        permission_denials: [],
        session_id: node.sessionId,
        receivedAt: node.receivedAt,
        synthesized: true,
      } as unknown as ClaudeStreamMessage;
    }
    case 'stream-event':
    case 'rate-limit':
    case 'lifecycle':
      return null;
  }
}
