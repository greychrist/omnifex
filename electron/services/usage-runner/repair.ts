/**
 * Repairs single-character corruption introduced by Claude Code's
 * cursor-positioning redraws in the `/usage` TUI.
 *
 * As of Claude Code 2.1.132 some sections (notably "What's contributing")
 * are rendered asynchronously over a placeholder using cursor-forward
 * sequences (`\x1b[<n>C`) to skip columns. Our linear ANSI strip turns
 * each such sequence into a single space, which means a character that
 * was previously rendered at that screen position is permanently lost
 * from the post-strip stream — `sessions` becomes `sessi ns`,
 * `Approximate` becomes `App oximate`, and so on.
 *
 * Crucially, Claude prints the affected words *uncorrupted* elsewhere in
 * the same buffer (e.g. "based on local sessions on this machine",
 * "subagent-heavy sessions", "(Sonnet only)"). The repair pass below
 * uses the buffer's own vocabulary as the canonical source: for each
 * adjacent alpha-token pair `<A> <B>` separated by a single space on the
 * same line, if some word in the vocabulary equals `A + ?c + B` for some
 * `c`, that's the original spelling — splice it back in.
 *
 * Conservative guardrails to avoid mangling legitimate prose:
 *   - Only merge when the vocab match is a complete standalone word
 *     elsewhere in the buffer.
 *   - Don't merge when both fragments occur multiple times in the
 *     buffer as their own complete tokens — at that point each is
 *     plausibly its own real word, not a fragment.
 *   - Don't merge across newline boundaries.
 *   - Apply iteratively until quiescent so multi-corruption ("Son et nly"
 *     → "Sonnet nly" → "Sonnet only") fully resolves.
 */

const ALPHA_RE = /^[A-Za-z][A-Za-z'-]*$/;
const MIN_REPAIR_LEN = 5;

interface Token {
  kind: 'alpha' | 'space' | 'other';
  text: string;
}

/**
 * Tokenize into alpha runs, single-space runs, and everything else
 * (newlines, punctuation, digits, multi-space etc.). Whitespace longer
 * than one space lives in `'other'` so adjacent alpha tokens with >1
 * space between them are never considered for merging.
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    // Alpha run
    if (
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a)
    ) {
      let j = i + 1;
      while (j < text.length) {
        const cc = text.charCodeAt(j);
        const isAlpha =
          (cc >= 0x41 && cc <= 0x5a) ||
          (cc >= 0x61 && cc <= 0x7a) ||
          cc === 0x27 /* ' */ ||
          cc === 0x2d /* - */;
        if (!isAlpha) break;
        j += 1;
      }
      tokens.push({ kind: 'alpha', text: text.slice(i, j) });
      i = j;
      continue;
    }
    // Single space (exactly one)
    if (text[i] === ' ' && text[i + 1] !== ' ') {
      tokens.push({ kind: 'space', text: ' ' });
      i += 1;
      continue;
    }
    // Everything else — single character at a time so newlines / punct
    // act as definite boundaries.
    tokens.push({ kind: 'other', text: text[i] });
    i += 1;
  }
  return tokens;
}

function buildAlphaCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const re = /[A-Za-z][A-Za-z'-]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  }
  return counts;
}

function buildVocabulary(counts: Map<string, number>): Set<string> {
  const vocab = new Set<string>();
  for (const [w] of counts) {
    if (w.length >= MIN_REPAIR_LEN) vocab.add(w);
  }
  return vocab;
}

export function repairCorruptedWords(text: string): string {
  let current = text;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = applyOnePass(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

function applyOnePass(text: string): string {
  const counts = buildAlphaCounts(text);
  const vocab = buildVocabulary(counts);
  if (vocab.size === 0) return text;

  const tokens = tokenize(text);
  let merged = false;

  // Walk pairs: alpha token, single-space, alpha token. Splice when a
  // merge applies.
  let i = 0;
  while (i < tokens.length - 2) {
    const a = tokens[i];
    const sp = tokens[i + 1];
    const b = tokens[i + 2];
    if (
      a.kind === 'alpha' &&
      sp.kind === 'space' &&
      b.kind === 'alpha' &&
      ALPHA_RE.test(a.text) &&
      ALPHA_RE.test(b.text)
    ) {
      const candidate = findRepairCandidate(a.text, b.text, vocab);
      if (candidate && shouldMerge(a.text, b.text, counts)) {
        tokens.splice(i, 3, { kind: 'alpha', text: candidate });
        merged = true;
        // Don't advance — the new merged token might combine with the
        // following pair on the next iteration.
        continue;
      }
    }
    i += 1;
  }
  if (!merged) return text;
  return tokens.map((t) => t.text).join('');
}

function findRepairCandidate(
  a: string,
  b: string,
  vocab: Set<string>,
): string | null {
  const targetLen = a.length + 1 + b.length;
  if (targetLen < MIN_REPAIR_LEN) return null;
  const concat = a + b;
  for (const word of vocab) {
    if (
      word.length === targetLen &&
      word.startsWith(a) &&
      word.endsWith(b) &&
      word !== concat
    ) {
      return word;
    }
  }
  return null;
}

/**
 * Refuse to merge when both fragments are themselves common standalone
 * tokens in the buffer — at that point either could plausibly be a real
 * word and the structural vocab match is more likely a coincidence than
 * a corruption signal.
 */
function shouldMerge(a: string, b: string, counts: Map<string, number>): boolean {
  const aCount = counts.get(a) ?? 0;
  const bCount = counts.get(b) ?? 0;
  // A fragment-of-corruption typically appears exactly once (only at the
  // corruption site). If BOTH tokens occur multiple times in the buffer,
  // both are likely real words and we leave them alone.
  if (aCount > 1 && bCount > 1) return false;
  return true;
}
