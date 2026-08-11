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
 * Convert free user input into a safe FTS5 MATCH expression.
 *
 * Every token is emitted as a quoted string literal, so no input can inject
 * operators, wildcards, or unbalanced quotes. Returns null when nothing
 * searchable remains — callers must return zero results rather than running a
 * query with an empty MATCH, which is a syntax error.
 */
export function toFtsQuery(input: string): string | null {
  const tokens = (input.match(TOKEN) ?? []).filter((t) => !FTS_KEYWORDS.has(t));
  if (tokens.length === 0) return null;
  // FTS5 escapes a double quote inside a string literal by doubling it. The
  // tokenizer above cannot emit one, but the escape is kept so this stays
  // correct if TOKEN ever widens.
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
}
