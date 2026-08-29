/**
 * FTS5 treats bare AND / OR / NOT / NEAR as operators. They are uppercase-only
 * in the FTS5 grammar, so dropping the uppercase forms leaves ordinary
 * lowercase words ("this or that") searchable as terms.
 */
const FTS_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

/**
 * Token characters must match the table's `tokenchars '-_'` setting, so that
 * `node-pty` is one query token exactly as it is one indexed token.
 */
const TOKEN = /[\p{L}\p{N}_-]+/gu;

/**
 * Longest input accepted, in characters. A longer query is truncated rather
 * than rejected: `registry.search()` only catches VaultConflictError, so an
 * oversized MATCH expression would surface as a raw SQLite error rejecting the
 * IPC call instead of as a search that simply found nothing useful. Generous
 * enough that no human-typed query is affected.
 */
const MAX_QUERY_CHARS = 512;

/**
 * Convert free user input into a safe FTS5 MATCH expression.
 *
 * Every token is emitted as a quoted string literal, so no input can inject
 * operators, wildcards, or unbalanced quotes. Returns null when nothing
 * searchable remains — callers must return zero results rather than running a
 * query with an empty MATCH, which is a syntax error.
 *
 * Tokens are ORed, not ANDed. ANDing made every extra word narrow the result
 * set to notes containing all of them, so describing what you wanted was
 * actively worse than naming one identifier: across real sessions the hit rate
 * fell from 83% at one term to 0% at four, while the vault held the content
 * the whole time. `search()` orders by bm25, which already scores a note
 * matching more of the query above one matching less — so OR degrades
 * gracefully where AND fell off a cliff.
 */
export function toFtsQuery(input: string): string | null {
  // Runtime guard: the IPC boundary is untyped at runtime, so callers may pass
  // non-strings despite the TypeScript signature. Treat non-strings the same as
  // "no searchable tokens" to maintain the contract that this function never throws.
  if (typeof input !== 'string') {
    return null;
  }

  const capped = input.slice(0, MAX_QUERY_CHARS);
  const tokens = (capped.match(TOKEN) ?? []).filter((t) => !FTS_KEYWORDS.has(t));
  if (tokens.length === 0) return null;
  // FTS5 escapes a double quote inside a string literal by doubling it. The
  // tokenizer above cannot emit one, but the escape is kept so this stays
  // correct if TOKEN ever widens.
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}
