import { describe, expect, it } from 'vitest';
import { extractResendPayload } from '../extractResendPayload';

describe('extractResendPayload', () => {
  it('returns empty payload when content is not an array', () => {
    // Boundary normalization (normalizeMessage) coerces string content into
    // array form before any caller sees it. Anything that still arrives as a
    // bare string here has skipped the boundary, so we refuse to resend it
    // rather than silently sending wrong-shaped wire data.
    expect(extractResendPayload({ content: 'hello world' })).toEqual({ text: '' });
  });

  it('joins text blocks with newlines (live-stream array shape)', () => {
    const result = extractResendPayload({
      content: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ],
    });
    expect(result).toEqual({ text: 'line one\nline two' });
  });

  it('extracts base64 images as data URLs alongside text', () => {
    const result = extractResendPayload({
      content: [
        { type: 'text', text: 'look at this' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
        },
      ],
    });
    expect(result).toEqual({
      text: 'look at this',
      images: ['data:image/png;base64,AAAA'],
    });
  });

  it('omits the images key entirely when there are no images', () => {
    // The resend callback signature is (text, images?) — passing
    // images: [] would be a behavior change vs the original.
    const result = extractResendPayload({
      content: [{ type: 'text', text: 'just text' }],
    });
    expect(result).toEqual({ text: 'just text' });
    expect('images' in result).toBe(false);
  });

  it('skips image blocks with non-base64 sources', () => {
    const result = extractResendPayload({
      content: [
        { type: 'text', text: 'x' },
        {
          type: 'image',
          source: { type: 'url', url: 'https://example.com/cat.png' },
        },
      ],
    });
    expect(result).toEqual({ text: 'x' });
  });

  it('skips image blocks missing media_type or data', () => {
    const result = extractResendPayload({
      content: [
        { type: 'text', text: 'x' },
        { type: 'image', source: { type: 'base64', data: 'AAAA' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
      ],
    });
    expect(result).toEqual({ text: 'x' });
  });

  it('returns an empty payload for null/undefined/missing content', () => {
    expect(extractResendPayload(null)).toEqual({ text: '' });
    expect(extractResendPayload(undefined)).toEqual({ text: '' });
    expect(extractResendPayload({})).toEqual({ text: '' });
    expect(extractResendPayload({ content: null })).toEqual({ text: '' });
  });

  it('ignores non-text-non-image blocks (tool_use, tool_result, …)', () => {
    const result = extractResendPayload({
      content: [
        { type: 'text', text: 'keep me' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file: 'x' } },
        { type: 'tool_result', tool_use_id: 't1', content: 'whatever' },
      ],
    });
    expect(result).toEqual({ text: 'keep me' });
  });
});
