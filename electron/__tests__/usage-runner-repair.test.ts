import { describe, it, expect } from 'vitest';
import { repairCorruptedWords } from '../services/usage-runner/repair';

// The /usage TUI in Claude Code 2.1.132 redraws the "What's contributing"
// section asynchronously over a "Refreshing…" placeholder using cursor
// positioning, which our linear ANSI strip can't replicate — single chars
// get dropped and replaced by a space, e.g. "sessions" → "sessi ns".
//
// Crucially, the same word usually appears uncorrupted elsewhere in the
// buffer (Claude prints "subagent-heavy sessions" or "based on local
// sessions on this machine" cleanly). The repair pass uses the buffer's
// own vocabulary as the source of truth: for each adjacent token pair
// `<A> <B>`, if the buffer contains a complete word equal to `A + ?c + B`,
// that's the original spelling — splice it back in.

describe('repairCorruptedWords', () => {
  it('repairs the canonical Greg case (sessions / sessi ns)', () => {
    const buffer =
      'Approximate, based on local sessions on this machine.\n' +
      'Longer sessi ns are more expensive even when cached.\n';
    const out = repairCorruptedWords(buffer);
    expect(out).toContain('Longer sessions are more expensive');
    expect(out).not.toContain('sessi ns');
    // Untouched copies are still untouched.
    expect(out).toContain('local sessions on this machine');
  });

  it('repairs Approximate / App oximate from the same buffer', () => {
    const buffer =
      'Approximate, based on local sessions on this machine.\n' +
      'App oximate, based on local sessions.\n';
    const out = repairCorruptedWords(buffer);
    expect(out).toContain('Approximate, based on local sessions on this machine');
    expect(out).toContain('Approximate, based on local sessions.');
    expect(out).not.toContain('App oximate');
  });

  it('iterates so multi-corruption like "Son et nly" → "Sonnet only" works', () => {
    // Both "Sonnet" and "only" appear cleanly elsewhere as standalone
    // tokens. The function must apply repair until quiescent so the two
    // adjacent corruptions on the same line both resolve.
    const buffer =
      'Current week (Sonnet only)\n' +
      'something Son et nly something\n';
    const out = repairCorruptedWords(buffer);
    expect(out).toContain('Sonnet only');
    expect(out).not.toContain('Son et nly');
  });

  it('does NOT merge legitimate adjacent words when both stand alone in the vocab', () => {
    // "the" and "at" are real standalone words; even if some longer word
    // beginning with "the" and ending with "at" existed in vocab, we
    // require at least one of the pair to be a non-standalone fragment
    // before merging — otherwise we'd corrupt natural English prose.
    const buffer =
      'See the at the entrance.\n' +
      'They sat at the bench.\n' +
      'theat is not a word but suppose it were.\n';
    const out = repairCorruptedWords(buffer);
    expect(out).toContain('See the at the entrance');
    expect(out).toContain('They sat at the bench');
  });

  it('leaves text alone when the vocabulary has no corresponding clean word', () => {
    // No "sessions" appears anywhere else in this buffer — nothing to
    // repair. We must NOT invent a fix.
    const buffer = 'Longer sessi ns are more expensive.\n';
    const out = repairCorruptedWords(buffer);
    expect(out).toBe(buffer);
  });

  it('preserves punctuation around the repaired word', () => {
    const buffer =
      'Approximate, based on local sessions on this machine.\n' +
      'Longer sessi ns, are more expensive.\n';
    const out = repairCorruptedWords(buffer);
    expect(out).toContain('Longer sessions, are more expensive.');
  });

  it("does not merge across newline boundaries", () => {
    const buffer =
      'sessions appear here cleanly\n' +
      'foo sessi\nns bar\n';
    const out = repairCorruptedWords(buffer);
    // The fragment 'sessi' is on one line; 'ns' is on the next — that's
    // a different visual layout, not a same-line corruption. Don't merge.
    expect(out).toContain('foo sessi\nns bar');
  });

  it('disambiguates two corruptions with different correct repairs in the same line', () => {
    // The corruption shape is length-preserving (a char is replaced by a
    // space, not deleted), so corrupted "sessions" (8) is "sessi ns" (8
    // char positions = 5+1+2) and corrupted "decisions" (9) is "decisi
    // ns" (9 char positions = 6+1+2). Both have suffix "ns", but the
    // length-of-merge gate keeps each corruption mapping to its own
    // correct vocabulary word.
    const buffer =
      'sessions and decisions appear cleanly.\n' +
      'Longer sessi ns are slow; decisi ns are hard.\n';
    const out = repairCorruptedWords(buffer);
    expect(out).toContain('Longer sessions are slow');
    expect(out).toContain('decisions are hard');
  });
});
