/** FTS5 operators are uppercase-only, so lowercase "or" stays a searchable term. */
const FTS_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

/** Must match the table's `tokenchars '-_'`. */
const TOKEN = /[\p{L}\p{N}_-]+/gu;

/** Truncate, never reject: an oversized MATCH would surface as a raw SQLite error. */
const MAX_QUERY_CHARS = 512;

/** Every token is quoted, so input cannot inject operators. Null means search nothing: an empty MATCH is a syntax error. ORed, not ANDed: AND fell to a 0% hit rate at four terms. */
export function toFtsQuery(input: string): string | null {
  // The IPC boundary is untyped at runtime, and this must never throw.
  if (typeof input !== 'string') {
    return null;
  }

  const capped = input.slice(0, MAX_QUERY_CHARS);
  const tokens = (capped.match(TOKEN) ?? []).filter((t) => !FTS_KEYWORDS.has(t));
  if (tokens.length === 0) return null;
  // TOKEN cannot emit a quote today; the escape guards a wider TOKEN.
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/** Same token rule as toFtsQuery, so callers look for exactly what the index matched. */
export function queryTerms(input: string): string[] {
  if (typeof input !== 'string') return [];
  const tokens = (input.slice(0, MAX_QUERY_CHARS).match(TOKEN) ?? []).filter(
    (t) => !FTS_KEYWORDS.has(t) && t.length >= 2,
  );
  return [...new Set(tokens.map((t) => t.toLowerCase()))];
}
