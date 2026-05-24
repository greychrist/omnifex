import type {
  JsonlNode,
  AssistantRaw,
  UserRaw,
  AttachmentRaw,
  QueueOpRaw,
} from '@/types/jsonl';

/**
 * Single source of truth for classifying a parsed JSONL line into the
 * renderer's taxonomy. Returns null for shapes we explicitly drop or
 * don't recognize — the caller appends only non-null results.
 *
 * Pure function; safe to call repeatedly on the same input. Tolerant of
 * missing optional fields (real JSONL lines often omit `timestamp` on
 * bookkeeping types).
 */
export function classifyJsonlLine(raw: unknown): JsonlNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (typeof type !== 'string') return null;

  const sessionId = typeof r.sessionId === 'string' ? r.sessionId : '';
  const receivedAt = typeof r.timestamp === 'string' ? r.timestamp : new Date().toISOString();

  switch (type) {
    case 'assistant':
      return classifyAssistant(r, sessionId, receivedAt);
    case 'user':
      return classifyUser(r, sessionId, receivedAt);
    case 'attachment':
      return classifyAttachment(r, sessionId, receivedAt);
    case 'queue-operation':
      return classifyQueueOp(r, sessionId, receivedAt);
    default:
      return null; // Other types covered in Task 4.
  }
}

function classifyAssistant(r: Record<string, unknown>, sessionId: string, receivedAt: string): JsonlNode | null {
  const message = r.message;
  if (!message || typeof message !== 'object') return null;
  return {
    kind: 'assistant',
    raw: r as unknown as AssistantRaw,
    sessionId,
    receivedAt,
  };
}

function classifyUser(r: Record<string, unknown>, sessionId: string, receivedAt: string): JsonlNode | null {
  const message = r.message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  // Discriminate prompt vs tool-result: tool-result user messages have
  // exclusively `tool_result` content blocks; user prompts contain text
  // blocks (or are bare strings, in which case they're definitely prompts).
  const userKind = isToolResultOnly(content) ? 'tool-result' : 'prompt';
  return {
    kind: 'user',
    raw: r as unknown as UserRaw,
    sessionId,
    receivedAt,
    userKind,
  };
}

function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return false;
  return content.every((c) => c && typeof c === 'object' && (c as { type?: string }).type === 'tool_result');
}

function classifyAttachment(r: Record<string, unknown>, sessionId: string, receivedAt: string): JsonlNode | null {
  if (!r.attachment || typeof r.attachment !== 'object') return null;
  return {
    kind: 'attachment',
    raw: r as unknown as AttachmentRaw,
    sessionId,
    receivedAt,
  };
}

function classifyQueueOp(r: Record<string, unknown>, sessionId: string, receivedAt: string): JsonlNode | null {
  if (typeof r.operation !== 'string') return null;
  return {
    kind: 'queue-operation',
    raw: r as unknown as QueueOpRaw,
    sessionId,
    receivedAt,
  };
}
