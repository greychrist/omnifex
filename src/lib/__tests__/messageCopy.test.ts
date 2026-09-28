import { describe, it, expect } from 'vitest';
import { extractCopyText } from '../messageCopy';

describe('extractCopyText', () => {
  it('reads a result message body from `result`', () => {
    expect(extractCopyText({ type: 'result', result: 'all done' })).toBe('all done');
  });

  it('joins a result message\'s `errors` when there is no `result`', () => {
    expect(extractCopyText({ type: 'result', errors: ['boom', 'again'] })).toBe('boom\nagain');
  });

  it('concatenates text blocks of an assistant message', () => {
    expect(
      extractCopyText({ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }),
    ).toContain('one');
  });

  it('returns empty string for a non-object', () => {
    expect(extractCopyText(null)).toBe('');
    expect(extractCopyText('nope')).toBe('');
  });

  // CLI 2.1.234: a text block can now arrive with no `text` field at all (the
  // release note is "Fixed a crash … a text block missing its text field").
  // This site was never actually broken — the parts array is flushed through
  // `join`, which coerces an absent entry to empty rather than to the string
  // "undefined" — so the `?? ''` added alongside the optional-field type change
  // is a type-honesty fix, not a behavior fix. Pinned here so a future refactor
  // to a manual concat (where the distinction bites) can't reintroduce it
  // silently in a file that otherwise has no tests at all.
  it('treats a text block with no `text` field as empty rather than copying "undefined"', () => {
    const copied = extractCopyText({ content: [{ type: 'text' }, { type: 'text', text: 'real' }] });
    expect(copied).not.toContain('undefined');
    expect(copied).toContain('real');
  });

  // MessageFrame's default bar hands over the transcript node itself, whose
  // body lives under `raw` — never at the top level.
  describe('transcript nodes', () => {
    it('reads a user or assistant node through raw.message', () => {
      const node = { kind: 'user', userKind: 'prompt', raw: { type: 'user', message: { role: 'user', content: 'plain prompt' } } };
      expect(extractCopyText(node)).toBe('plain prompt');
      const blocks = { kind: 'assistant', raw: { type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } } };
      expect(extractCopyText(blocks)).toBe('reply');
    });

    it('reads a result node through raw', () => {
      expect(extractCopyText({ kind: 'result', raw: { type: 'result', result: 'all done' } })).toBe('all done');
    });

    it('is empty for a node with no readable body, like a rate-limit event', () => {
      expect(extractCopyText({ kind: 'rate-limit', raw: { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } } })).toBe('');
    });
  });
});
