import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { createDefaultConfig } from '../messageRenderingConfig';
import { buildModernItems } from '../modernGrouping';
import { keepUnchangedFooters, modernTurnFooters, turnFooterText } from '../modernTurnFooter';

const at = (s: number) => new Date(Date.UTC(2026, 9, 31, 10, 0, s)).toISOString();

function prompt(t: string, s: number): JsonlNode {
  return { kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: at(s), raw: { type: 'user', message: { role: 'user', content: [{ type: 'text', text: t }] } } } as unknown as JsonlNode;
}

function assistant(blocks: unknown[], s: number, extra: Record<string, unknown> = {}): JsonlNode {
  return {
    kind: 'assistant', sessionId: '', receivedAt: at(s),
    raw: { type: 'assistant', ...extra, message: { role: 'assistant', model: 'claude-sonnet-5-5', content: blocks, stop_reason: null, ...(extra.message as object ?? {}) } },
  } as unknown as JsonlNode;
}

const text = (t: string, s: number, extra?: Record<string, unknown>) => assistant([{ type: 'text', text: t }], s, extra);
const toolUse = (id: string, s: number, extra?: Record<string, unknown>) => assistant([{ type: 'tool_use', id, name: 'Bash', input: {} }], s, extra);

function toolResult(id: string, s: number): JsonlNode {
  return {
    kind: 'user', userKind: 'tool-result', sessionId: '', receivedAt: at(s),
    raw: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } },
  } as unknown as JsonlNode;
}

function footersFor(messages: JsonlNode[], running = false) {
  const items = buildModernItems(messages, createDefaultConfig());
  return { items, footers: modernTurnFooters(items, messages, running) };
}

describe('modernTurnFooters', () => {
  it('marks the answer that ends a turn with its duration and step count', () => {
    const { items, footers } = footersFor([
      prompt('go', 0), toolUse('a', 2), toolResult('a', 3), toolUse('b', 4), toolResult('b', 5), text('Done.', 72),
    ]);
    const answer = items[items.length - 1];
    expect(answer.kind).toBe('text');
    const footer = footers.get(answer.key);
    expect(footer?.ms).toBe(72_000);
    expect(footer?.steps).toBe(2);
  });

  it('marks only the last answer of each turn', () => {
    const { items, footers } = footersFor([
      prompt('one', 0), text('first thought', 1), toolUse('a', 2), toolResult('a', 3), text('end one', 4),
      prompt('two', 10), text('end two', 12),
    ]);
    const marked = items.filter((i) => footers.has(i.key)).map((i) => (i.kind === 'text' ? i.text : i.kind));
    expect(marked).toEqual(['end one', 'end two']);
  });

  it('leaves a running turn unmarked until it finishes', () => {
    const rows = [prompt('go', 0), text('partial', 1)];
    expect(footersFor(rows, true).footers.size).toBe(0);
    expect(footersFor(rows, false).footers.size).toBe(1);
  });

  it('does not mark a turn that ended on something other than an answer', () => {
    const { footers } = footersFor([prompt('go', 0), text('looking', 1), toolUse('a', 2), toolResult('a', 3)]);
    expect(footers.size).toBe(0);
  });

  it('has no duration without a prompt to measure from', () => {
    const { items, footers } = footersFor([text('resumed', 5)]);
    expect(footers.get(items[0].key)?.ms).toBeNull();
  });

  it('prices each API message once, however many records carry its usage', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 0 };
    const req = { requestId: 'r1', message: { id: 'm1', usage } };
    const { items, footers } = footersFor([
      prompt('go', 0), toolUse('a', 1, req), toolResult('a', 2), text('Done.', 3, req),
    ]);
    const once = footersFor([prompt('go', 0), text('Done.', 3, req)]);
    const usd = footers.get(items[items.length - 1].key)?.usd;
    expect(usd).toBeGreaterThan(0);
    expect(usd).toBe(once.footers.get(once.items[once.items.length - 1].key)?.usd);
  });

  it('has no cost when no message in the turn carries usage', () => {
    const { items, footers } = footersFor([prompt('go', 0), text('Done.', 1)]);
    expect(footers.get(items[1].key)?.usd).toBeNull();
  });
});

describe('turnFooterText', () => {
  it('reads Done, then whichever figures it has', () => {
    expect(turnFooterText({ ms: 252_000, steps: 23, usd: 0.384 }, true)).toBe('Done · 4m 12s · 23 steps · $0.38');
    expect(turnFooterText({ ms: 500, steps: 1, usd: null }, true)).toBe('Done · 1 step');
    expect(turnFooterText({ ms: null, steps: 0, usd: null }, true)).toBe('Done');
  });

  it('leaves the cost out when told to', () => {
    expect(turnFooterText({ ms: 3_000, steps: 0, usd: 1.5 }, false)).toBe('Done · 3s');
  });
});

describe('keepUnchangedFooters', () => {
  it('keeps the previous object for a footer whose figures did not change', () => {
    const a = { ms: 1, steps: 2, usd: 3 };
    const prev = new Map([['k', a]]);
    const next = keepUnchangedFooters(prev, new Map([['k', { ms: 1, steps: 2, usd: 3 }]]));
    expect(next.get('k')).toBe(a);
    const changed = keepUnchangedFooters(prev, new Map([['k', { ms: 1, steps: 3, usd: 3 }]]));
    expect(changed.get('k')).not.toBe(a);
  });
});
