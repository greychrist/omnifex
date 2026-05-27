import { describe, expect, it } from 'vitest';
import { normalizeJsonlNode } from '../normalizeMessage';
import type { JsonlNode } from '@/types/jsonl';

describe('normalizeJsonlNode', () => {
  it('a normalized CLI-shaped slash-command message still classifies as user.command', async () => {
    // Regression guard. JSONL-restored slash commands arrive as
    // `content: "<command-name>/clear</command-name>…"` (string). After
    // normalizeJsonlNode wraps them, the downstream classifier must still
    // detect the command pattern in the resulting text block — the renderer
    // relies on the `user.command` classification to swap in CommandWidget.
    const { classifyStandaloneKind } = await import('../messageKind');
    const node = {
      kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '',
      raw: {
        type: 'user',
        message: {
          role: 'user',
          content:
            '<command-name>/clear</command-name><command-message>Clear context</command-message><command-args></command-args>',
        },
      },
    } as unknown as JsonlNode;
    const normalized = normalizeJsonlNode(node);
    expect(classifyStandaloneKind(normalized, [normalized])).toBe('user.command');
  });

  it('wraps a bare string content into a single text block for user nodes', () => {
    const node = {
      kind: 'user',
      userKind: 'prompt',
      sessionId: 's1',
      receivedAt: '',
      raw: {
        type: 'user',
        message: { role: 'user', content: 'hello world' },
      },
    } as unknown as JsonlNode;
    const out = normalizeJsonlNode(node);
    const content = (out as unknown as { raw: { message?: { content?: unknown } } }).raw.message?.content;
    expect(content).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('wraps a bare string content into a single text block for assistant nodes', () => {
    const node = {
      kind: 'assistant',
      sessionId: 's1',
      receivedAt: '',
      raw: {
        type: 'assistant',
        message: { role: 'assistant', content: 'inline reply' },
      },
    } as unknown as JsonlNode;
    const out = normalizeJsonlNode(node);
    const content = (out as unknown as { raw: { message?: { content?: unknown } } }).raw.message?.content;
    expect(content).toEqual([{ type: 'text', text: 'inline reply' }]);
  });

  it('is idempotent on array-shaped content', () => {
    const blocks = [{ type: 'text', text: 'a' }];
    const node = {
      kind: 'user',
      userKind: 'prompt',
      sessionId: 's1',
      receivedAt: '',
      raw: {
        type: 'user',
        message: { role: 'user', content: blocks },
      },
    } as unknown as JsonlNode;
    const out = normalizeJsonlNode(node);
    const content = (out as unknown as { raw: { message?: { content?: unknown } } }).raw.message?.content;
    expect(content).toBe(blocks);
  });

  it('converts empty string to an empty array', () => {
    const node = {
      kind: 'user',
      userKind: 'prompt',
      sessionId: 's1',
      receivedAt: '',
      raw: {
        type: 'user',
        message: { role: 'user', content: '' },
      },
    } as unknown as JsonlNode;
    const out = normalizeJsonlNode(node);
    const content = (out as unknown as { raw: { message?: { content?: unknown } } }).raw.message?.content;
    expect(content).toEqual([]);
  });

  it('passes non-assistant/user nodes through unchanged', () => {
    const node = {
      kind: 'system',
      subtype: 'init',
      sessionId: 's1',
      receivedAt: '',
      raw: { type: 'system', subtype: 'init' },
    } as unknown as JsonlNode;
    expect(normalizeJsonlNode(node)).toBe(node);
  });
});
