/**
 * Normalize a Claude SDK / JSONL message so `message.content` is always a
 * block array, never a bare string.
 *
 * The Anthropic Messages API allows `content` to be either a string or an
 * array of typed blocks — semantically equivalent (`"hi"` ≡ `[{type:'text',text:'hi'}]`).
 * Both shapes appear in practice:
 *
 *   • Live SDK stream → user prompts synthesized by the renderer use the array
 *     form (see useSendPrompt). Assistant messages also use array form.
 *   • Resumed sessions → the Claude CLI's JSONL persists whatever was sent
 *     originally; plain-text user prompts come back as bare strings.
 *
 * Letting the dual shape leak past the IPC / JSONL boundary forces every read
 * site downstream (StreamMessage, messageFilters, compactGrouping, …) to
 * branch on `typeof content === 'string'` vs `Array.isArray(content)`. We had
 * ~70 such branches and ~one quiet bug per year hiding in them (Resend on
 * resumed sessions, for example, returned an empty payload from the array-only
 * extractor).
 *
 * The fix is one-shot normalization at the boundary:
 *
 *   • `loadSessionHistory()` applies this to each row after JSONL parse.
 *   • `handleJsonlLine()` applies this to each parsed live message.
 *
 * After both call sites, every downstream consumer can assume array form.
 *
 * The helper is intentionally narrow:
 *   • Idempotent — array form passes through untouched.
 *   • Pure — returns a shallow-copied wrapper, leaves nested arrays as-is.
 *   • Tolerant — unknown shapes (no `.message`, weird types) round-trip
 *     unchanged rather than throwing.
 *
 * Note: this only normalizes the top-level `message.content`. Tool-result
 * blocks inside an array can ALSO have string-vs-array content (handled
 * locally in extractCopyText and friends). Leaving those for a follow-up
 * pass because they're less widely-branched than the top-level shape.
 */

/**
 * Generic over the caller's type so a `ClaudeStreamMessage` round-trips as a
 * `ClaudeStreamMessage`. The body inspects `(raw as any).message?.content`
 * because the SDK's `BetaMessage` doesn't accept an `unknown`-indexed shape
 * — making the public signature `<T>(raw: T): T` keeps callers honest and
 * keeps the internal access unobtrusive.
 */
export function normalizeMessageContent<T>(raw: T): T {
  if (!raw || typeof raw !== 'object') return raw;

  const inner = (raw as { message?: unknown }).message;
  if (!inner || typeof inner !== 'object') return raw;

  const content = (inner as { content?: unknown }).content;
  if (typeof content !== 'string') return raw;

  // String content → wrap as a single text block. Empty string becomes an
  // empty array (no synthetic empty-text block) so downstream "did the user
  // type anything?" checks still see zero blocks.
  const nextContent =
    content.length === 0 ? [] : [{ type: 'text', text: content }];

  return {
    ...raw,
    message: {
      ...(inner as Record<string, unknown>),
      content: nextContent,
    },
  };
}
