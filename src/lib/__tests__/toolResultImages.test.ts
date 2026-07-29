import { describe, it, expect } from 'vitest';
import { extractToolResultImages } from '../toolResultImages';

const PNG = 'iVBORw0KGgoAAAANSUhEUg==';

describe('extractToolResultImages', () => {
  it('pulls a base64 image out of an array-shaped tool_result', () => {
    expect(
      extractToolResultImages({
        type: 'tool_result',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }],
      }),
    ).toEqual([{ dataUrl: `data:image/png;base64,${PNG}`, mediaType: 'image/png' }]);
  });

  it('keeps every image when a tool returns several', () => {
    const images = extractToolResultImages({
      type: 'tool_result',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
        { type: 'text', text: 'Screenshot captured' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB' } },
      ],
    });
    expect(images.map((i) => i.mediaType)).toEqual(['image/png', 'image/jpeg']);
  });

  // MCP servers speak `{data, mimeType}`; whether the CLI normalizes that into
  // Anthropic's `source` shape isn't guaranteed across versions, so accept both
  // rather than silently dropping the image on a CLI change.
  it('also accepts the raw MCP {data, mimeType} shape', () => {
    expect(
      extractToolResultImages({
        type: 'tool_result',
        content: [{ type: 'image', data: PNG, mimeType: 'image/png' }],
      }),
    ).toEqual([{ dataUrl: `data:image/png;base64,${PNG}`, mediaType: 'image/png' }]);
  });

  it('defaults the media type when the payload omits it', () => {
    const [img] = extractToolResultImages({
      type: 'tool_result',
      content: [{ type: 'image', source: { type: 'base64', data: PNG } }],
    });
    expect(img.mediaType).toBe('image/png');
  });

  it('passes through an already-formed data URL without double-prefixing', () => {
    const url = `data:image/png;base64,${PNG}`;
    expect(
      extractToolResultImages({
        type: 'tool_result',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: url } }],
      }),
    ).toEqual([{ dataUrl: url, mediaType: 'image/png' }]);
  });

  it('returns [] for a string-shaped tool_result', () => {
    expect(extractToolResultImages({ type: 'tool_result', content: 'ok' })).toEqual([]);
  });

  it('returns [] for a text-only tool_result', () => {
    expect(
      extractToolResultImages({ type: 'tool_result', content: [{ type: 'text', text: 'done' }] }),
    ).toEqual([]);
  });

  it('ignores image blocks carrying no data rather than emitting a broken src', () => {
    expect(
      extractToolResultImages({
        type: 'tool_result',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
          { type: 'image' },
        ],
      }),
    ).toEqual([]);
  });

  it('is null-safe on malformed input', () => {
    expect(extractToolResultImages(null)).toEqual([]);
    expect(extractToolResultImages(undefined)).toEqual([]);
    expect(extractToolResultImages({})).toEqual([]);
    expect(extractToolResultImages({ type: 'tool_result' })).toEqual([]);
    expect(extractToolResultImages({ type: 'tool_result', content: [null, 'str', 42] })).toEqual([]);
  });
});
