/**
 * Extract a resend-able payload from a user message's content array.
 *
 * Boundary normalization (see `normalizeMessage.ts`) guarantees the renderer's
 * `messages[]` state always carries content as an array of typed blocks — the
 * JSONL-restored string shape gets wrapped at ingress. This helper assumes
 * that invariant: a non-array `content` is treated as "nothing to resend"
 * rather than re-decoding a legacy shape downstream.
 */
export interface ResendPayload {
  text: string;
  images?: string[];
}

export function extractResendPayload(msg: unknown): ResendPayload {
  if (!msg || typeof msg !== 'object') {
    return { text: '' };
  }

  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return { text: '' };
  }

  const textParts: string[] = [];
  const images: string[] = [];

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;

    if (b.type === 'text' && typeof b.text === 'string') {
      textParts.push(b.text);
      continue;
    }

    if (b.type === 'image') {
      const source = b.source as
        | { type?: string; media_type?: string; data?: string }
        | undefined;
      if (source?.type === 'base64' && source.media_type && source.data) {
        images.push(`data:${source.media_type};base64,${source.data}`);
      }
    }
  }

  return {
    text: textParts.join('\n'),
    ...(images.length > 0 ? { images } : {}),
  };
}
