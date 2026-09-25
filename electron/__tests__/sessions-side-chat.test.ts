// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createSideChatStore, SIDE_CHAT_HISTORY_LIMIT } from '../services/sessions/side-chat';

const fixed = () => new Date('2026-09-25T12:00:00Z');

describe('side chat store', () => {
  it('ask appends a pending exchange with empty history', () => {
    const s = createSideChatStore(fixed);
    const a = s.ask('  why?  ');
    expect(a.exchange).toMatchObject({ question: 'why?', status: 'pending', askedAt: '2026-09-25T12:00:00.000Z' });
    expect(a.history).toEqual([]);
    expect(s.snapshot().exchanges).toHaveLength(1);
  });

  it('rejects blank and concurrent asks', () => {
    const s = createSideChatStore(fixed);
    expect(() => s.ask('   ')).toThrow('Question is blank');
    s.ask('one');
    expect(() => s.ask('two')).toThrow('A side question is already pending');
  });

  it('settle maps a string to answered and null to no-answer', () => {
    const s = createSideChatStore(fixed);
    const a = s.ask('q1');
    expect(s.settle(a.exchange.id, a.generation, 'A1')).toBe(true);
    const b = s.ask('q2');
    s.settle(b.exchange.id, b.generation, null);
    expect(s.snapshot().exchanges.map((e) => e.status)).toEqual(['answered', 'no-answer']);
    expect(s.snapshot().exchanges[0].answer).toBe('A1');
  });

  it('history is only answered exchanges, capped at the limit', () => {
    const s = createSideChatStore(fixed);
    for (let i = 0; i < SIDE_CHAT_HISTORY_LIMIT + 2; i++) {
      const a = s.ask(`q${i}`);
      s.settle(a.exchange.id, a.generation, `a${i}`);
    }
    const f = s.ask('fails');
    s.fail(f.exchange.id, f.generation, 'boom');
    const next = s.ask('next');
    expect(next.history).toHaveLength(SIDE_CHAT_HISTORY_LIMIT);
    expect(next.history[0]).toEqual({ question: 'q2', response: 'a2' });
    expect(next.history.some((h) => h.question === 'fails')).toBe(false);
  });

  it('close empties the thread and drops late replies', () => {
    const s = createSideChatStore(fixed);
    const a = s.ask('q');
    s.close();
    expect(s.snapshot().exchanges).toEqual([]);
    expect(s.settle(a.exchange.id, a.generation, 'late')).toBe(false);
    expect(s.fail(a.exchange.id, a.generation, 'late')).toBe(false);
    const b = s.ask('fresh');
    expect(s.settle(a.exchange.id, a.generation, 'late')).toBe(false);
    expect(s.snapshot().exchanges).toEqual([expect.objectContaining({ id: b.exchange.id, status: 'pending' })]);
  });

  it('snapshot is a copy', () => {
    const s = createSideChatStore(fixed);
    s.ask('q');
    s.snapshot().exchanges[0].question = 'mutated';
    expect(s.snapshot().exchanges[0].question).toBe('q');
  });
});
