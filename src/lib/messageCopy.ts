import type { MessageContentBlock } from "@/types/claudeStream";

/**
 * Pulls a human-readable copy-target string out of any stream message.
 *
 * Result messages (`type === 'result'`) carry their body on `result`
 * (success) or `errors` (error) — they have no `content` array. Assistant
 * and user messages carry their body inside `content` as typed blocks
 * (text / tool_use / tool_result). Handle both shapes here so every
 * caller using this helper gets a consistent value.
 *
 * A transcript node (`{ kind, raw, … }`, what MessageFrame's default bar is
 * handed) carries none of that at the top level — its body is the wire record
 * under `raw`, and for user/assistant records under `raw.message`. It is read
 * through that, after the top level has had its chance.
 *
 * Returns `''` when there's nothing to copy.
 */
export function extractCopyText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return '';
  const direct = extractFromMessage(msg);
  if (direct) return direct;
  const raw = (msg as { raw?: unknown }).raw;
  if (!raw || typeof raw !== 'object') return '';
  const r = raw as { type?: unknown; message?: unknown };
  return extractFromMessage(r.type === 'result' ? r : (r.message ?? r));
}

function extractFromMessage(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return '';
  const m = msg as {
    type?: unknown;
    result?: unknown;
    errors?: unknown;
    content?: unknown;
  };
  if (m.type === 'result') {
    if (typeof m.result === 'string' && m.result.length > 0) return m.result;
    if (Array.isArray(m.errors)) {
      return m.errors.filter((e) => typeof e === 'string').join('\n');
    }
    return '';
  }
  const content = m.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content as MessageContentBlock[]) {
    if (c.type === 'text') {
      parts.push(c.text ?? '');
    } else if (c.type === 'tool_use') {
      const input = c.input;
      if (typeof input.command === 'string') parts.push(input.command);
      else if (typeof input.content === 'string') parts.push(input.content);
      else if (typeof input.pattern === 'string') parts.push(input.pattern);
    } else if (c.type === 'tool_result') {
      if (typeof c.content === 'string') parts.push(c.content);
      else if (Array.isArray(c.content)) {
        for (const inner of c.content) {
          if (typeof inner === 'string') parts.push(inner);
          else if ('text' in inner && typeof inner.text === 'string') parts.push(inner.text);
        }
      }
    }
  }
  return parts.join('\n').trim();
}
