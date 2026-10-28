import { describe, it, expect } from 'vitest';
import { extractResultContent } from '../shared';

describe('extractResultContent', () => {
  // Read on a PNG returns its image as a ~300 KB base64 block. Stringified,
  // that became one unbreakable line in ReadResultWidget, and WebKit spent
  // seconds per layout measuring it — a 12-minute freeze on 2026-10-28 with
  // four screenshots in Verbose. The image itself renders beneath the widget.
  it('leaves image blocks out of the text', () => {
    const data = 'iVBORw0KGgo'.repeat(1000);
    const text = extractResultContent({
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }],
    });
    expect(text).toBe('');
  });

  it('keeps the text blocks beside an image', () => {
    expect(extractResultContent({
      content: [{ type: 'text', text: 'caption' }, { type: 'image', source: { type: 'base64', data: 'x' } }],
    })).toBe('caption');
  });

  it('still joins text blocks and passes strings through', () => {
    expect(extractResultContent({ content: [{ type: 'text', text: 'a' }, 'b'] })).toBe('a\nb');
    expect(extractResultContent({ content: 'plain' })).toBe('plain');
  });
});
