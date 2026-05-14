import { describe, expect, it } from 'vitest';
import { normalizeMessageContent } from '../normalizeMessage';

describe('normalizeMessageContent', () => {
  it('wraps a string content in a single text block', () => {
    const input = {
      type: 'user',
      message: { role: 'user', content: 'hello world' },
    };
    const out = normalizeMessageContent(input);
    expect(out.message?.content).toEqual([{ type: 'text', text: 'hello world' }]);
    // role must be preserved alongside the rewritten content
    expect((out.message as { role?: string }).role).toBe('user');
  });

  it('is idempotent on array-shaped content', () => {
    const blocks = [
      { type: 'text', text: 'a' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } },
    ];
    const input = { type: 'user', message: { content: blocks } };
    const out = normalizeMessageContent(input);
    // Same reference for the array — we don't deep-copy when not needed
    expect(out.message?.content).toBe(blocks);
  });

  it('returns the input unchanged when message is absent', () => {
    const input = { type: 'system', subtype: 'init' };
    expect(normalizeMessageContent(input)).toBe(input);
  });

  it('returns the input unchanged when message is not an object', () => {
    // Runtime tolerance — the helper is intentionally loose about its
    // input. Cast through unknown so TS doesn't reject the malformed shape.
    const input = { type: 'user', message: 'huh?' } as unknown as {
      type: string;
      message: { content?: unknown };
    };
    expect(normalizeMessageContent(input)).toBe(input);
  });

  it('preserves the OmnifexEnvelope fields at the top level', () => {
    const input = {
      type: 'user',
      receivedAt: '2026-05-14T10:00:00Z',
      timestamp: '2026-05-14T10:00:00Z',
      isMeta: false,
      uuid: 'abc',
      message: { role: 'user', content: 'hi' },
    };
    const out = normalizeMessageContent(input);
    expect(out.receivedAt).toBe('2026-05-14T10:00:00Z');
    expect(out.timestamp).toBe('2026-05-14T10:00:00Z');
    expect(out.uuid).toBe('abc');
    expect(out.message?.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('preserves extra inner-message fields (e.g. id, model)', () => {
    const input = {
      type: 'assistant',
      message: {
        id: 'msg_01',
        model: 'claude-opus-4-7',
        role: 'assistant',
        content: 'inline',
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    };
    const out = normalizeMessageContent(input);
    const m = out.message as { id?: string; model?: string; usage?: unknown };
    expect(m.id).toBe('msg_01');
    expect(m.model).toBe('claude-opus-4-7');
    expect(m.usage).toEqual({ input_tokens: 1, output_tokens: 2 });
    expect(out.message?.content).toEqual([{ type: 'text', text: 'inline' }]);
  });

  it('converts an empty string to an empty array (not a synthetic empty-text block)', () => {
    // Downstream code asks "did the user say anything?" by reading the array
    // length. A wrapper of [{type:'text', text:''}] would lie.
    const input = { type: 'user', message: { content: '' } };
    const out = normalizeMessageContent(input);
    expect(out.message?.content).toEqual([]);
  });

  it('tolerates null and undefined', () => {
    expect(normalizeMessageContent(null)).toBeNull();
    expect(normalizeMessageContent(undefined)).toBeUndefined();
  });

  it('does not mutate the input', () => {
    const input = { type: 'user', message: { content: 'hi' } };
    const before = JSON.parse(JSON.stringify(input));
    normalizeMessageContent(input);
    expect(input).toEqual(before);
  });

  it('a normalized CLI-shaped slash-command message still classifies as user.command', async () => {
    // Regression guard. JSONL-restored slash commands arrive as
    // `content: "<command-name>/clear</command-name>…"` (string). After this
    // helper wraps them, the downstream classifier must still detect the
    // command pattern in the resulting text block — the renderer relies on
    // the `user.command` classification to swap in CommandWidget.
    const { classifyStandaloneKind } = await import('../messageKind');
    const raw = {
      type: 'user',
      message: {
        content:
          '<command-name>/clear</command-name><command-message>Clear context</command-message><command-args></command-args>',
      },
    } as const;
    const normalized = normalizeMessageContent(raw);
    expect(classifyStandaloneKind(normalized as any, [normalized as any])).toBe('user.command');
  });
});
