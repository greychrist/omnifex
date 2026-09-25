import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { deriveThinkingStatus, lastTurnThinkingTokens } from '../thinkingStatus';

const thinkingTokens = (estimated_tokens: number, receivedAt = ''): JsonlNode =>
  ({
    kind: 'system', subtype: 'thinking_tokens', sessionId: '', receivedAt,
    raw: { type: 'system', subtype: 'thinking_tokens', estimated_tokens },
  }) as unknown as JsonlNode;

const status = (value: string): JsonlNode =>
  ({
    kind: 'system', subtype: 'status', sessionId: '', receivedAt: '',
    raw: { type: 'system', subtype: 'status', status: value },
  }) as unknown as JsonlNode;

const assistantText = (text: string): JsonlNode =>
  ({
    kind: 'assistant', sessionId: '', receivedAt: '',
    raw: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }) as unknown as JsonlNode;

const userText = (text: string): JsonlNode =>
  ({
    kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '',
    raw: { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } },
  }) as unknown as JsonlNode;

describe('deriveThinkingStatus', () => {
  it('reports the running total while a burst is streaming', () => {
    expect(
      deriveThinkingStatus([userText('hi'), thinkingTokens(50), thinkingTokens(1300)]),
    ).toEqual({ tokens: 1300, startedAt: null });
  });

  it('returns null for an empty transcript', () => {
    expect(deriveThinkingStatus([])).toBeNull();
  });

  it('returns null once the assistant starts answering', () => {
    // The burst is over the moment a non-system node lands, so the bar
    // disappears on its own without any turn-end plumbing.
    expect(
      deriveThinkingStatus([thinkingTokens(900), assistantText('here goes')]),
    ).toBeNull();
  });

  it('stays active across interleaved system:status pings', () => {
    // `status` pings share the stream with thinking_tokens and are themselves
    // never rendered; treating one as a burst terminator would blink the bar
    // out mid-thought.
    expect(
      deriveThinkingStatus([thinkingTokens(600), status('requesting')]),
    ).toEqual({ tokens: 600, startedAt: null });
  });

  it('returns null when the session never thought', () => {
    expect(deriveThinkingStatus([userText('hi'), assistantText('yo')])).toBeNull();
  });

  it('ignores a ping with no estimated_tokens rather than reporting NaN', () => {
    const malformed = ({
      kind: 'system', subtype: 'thinking_tokens', sessionId: '', receivedAt: '',
      raw: { type: 'system', subtype: 'thinking_tokens' },
    }) as unknown as JsonlNode;
    expect(deriveThinkingStatus([malformed])).toBeNull();
  });
});

describe('deriveThinkingStatus — burst start', () => {
  it('times the burst from its first ping, not its most recent', () => {
    // The elapsed counter has to keep climbing as pings arrive. Reading the
    // newest ping's timestamp would reset it to zero every few hundred tokens.
    const status = deriveThinkingStatus([
      thinkingTokens(200, '2026-09-11T10:00:00Z'),
      thinkingTokens(900, '2026-09-11T10:00:12Z'),
    ]);

    expect(status).toEqual({ tokens: 900, startedAt: Date.parse('2026-09-11T10:00:00Z') });
  });

  it('restarts the clock on a new burst', () => {
    const status = deriveThinkingStatus([
      thinkingTokens(900, '2026-09-11T10:00:00Z'),
      assistantText('done'),
      thinkingTokens(100, '2026-09-11T10:05:00Z'),
    ]);

    expect(status?.startedAt).toBe(Date.parse('2026-09-11T10:05:00Z'));
  });
});

describe('lastTurnThinkingTokens', () => {
  it('returns the burst total after the burst has ended', () => {
    expect(
      lastTurnThinkingTokens([userText('go'), thinkingTokens(1200), thinkingTokens(4800), assistantText('done')]),
    ).toBe(4800);
  });

  it('returns the open burst total while it is still running', () => {
    expect(lastTurnThinkingTokens([userText('go'), assistantText('x'), thinkingTokens(900)])).toBe(900);
  });

  it('tallies every burst since the last prompt, not just the newest', () => {
    // Each burst's pings are a running total for THAT burst; a turn that
    // thinks, calls a tool, and thinks again spent both.
    expect(
      lastTurnThinkingTokens([
        userText('go'),
        thinkingTokens(300), thinkingTokens(9000), assistantText('a'),
        thinkingTokens(50), thinkingTokens(100), status('requesting'), assistantText('b'),
      ]),
    ).toBe(9100);
  });

  it('stops at the last prompt, leaving earlier turns out', () => {
    expect(
      lastTurnThinkingTokens([
        userText('one'), thinkingTokens(5000), assistantText('a'),
        userText('two'), thinkingTokens(200), assistantText('b'),
      ]),
    ).toBe(200);
  });

  it("returns null when the latest turn did not think, rather than the previous turn's figure", () => {
    expect(
      lastTurnThinkingTokens([userText('one'), thinkingTokens(5000), assistantText('a'), userText('two'), assistantText('b')]),
    ).toBeNull();
  });

  it('returns null for an empty transcript', () => {
    expect(lastTurnThinkingTokens([])).toBeNull();
  });

  it('survives the burst closing, which is where deriveThinkingStatus gives up', () => {
    const closed = [userText('go'), thinkingTokens(4800), assistantText('here you go')];
    expect(deriveThinkingStatus(closed)).toBeNull();
    expect(lastTurnThinkingTokens(closed)).toBe(4800);
  });

  it('still reports through a trailing system:status ping', () => {
    expect(lastTurnThinkingTokens([userText('go'), thinkingTokens(4800), status('requesting')])).toBe(4800);
  });
});
