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

function deriveStreamKind(node: JsonlNode): string {
  switch (node.kind) {
    case 'user':
      switch (node.userKind) {
        case 'prompt': return 'user.prompt';
        case 'tool-result': return 'user.tool-result';
        case 'meta-skill': return 'user.meta.skill';
        case 'meta-attachment': return 'user.meta.attachment';
        case 'meta-other': return 'user.meta.other';
      }
      return 'user.prompt';
    case 'assistant':
      // assistant message-level streamKind defaults to the message's dominant
      // block kind; per-block kind lookups happen separately via blockKind.ts.
      return 'assistant.text';
    case 'system':
      return `system.${(node.raw as { subtype?: string }).subtype ?? 'informational'}`;
    case 'attachment':       return 'attachment';
    case 'queue-operation':  return 'queue-operation';
    case 'last-prompt':      return 'last-prompt';
    case 'permission-mode':  return 'permission-mode';
    case 'ai-title':         return 'ai-title';
    case 'file-history-snapshot': return 'file-history-snapshot';
    case 'unknown':
      return 'unknown';
    case 'stream-event':
    case 'rate-limit':
    case 'lifecycle':
      // These are overlay kinds and will return null from the adapter,
      // so streamKind is irrelevant — but exhaustiveness requires a branch.
      return 'overlay';
  }
}

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
      raw.streamKind = deriveStreamKind(node);
      return raw;
    }
    case 'unknown': {
      // Pass the raw object through as a ClaudeStreamMessage so downstream
      // consumers can still inspect the original fields. Tag it with
      // streamKind = 'unknown' so filters and renderers can handle it.
      const raw = node.raw as unknown as ClaudeStreamMessage;
      raw.streamKind = 'unknown';
      if (node.receivedAt) {
        (raw as { receivedAt?: string }).receivedAt = node.receivedAt;
      }
      return raw;
    }
    case 'stream-event':
    case 'rate-limit':
    case 'lifecycle':
      return null;
  }
}
