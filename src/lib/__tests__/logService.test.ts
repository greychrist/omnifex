import { describe, it, expect } from 'vitest';
import { formatLogArgs } from '../logService';

describe('formatLogArgs', () => {
  it('passes string args through unchanged', () => {
    expect(formatLogArgs(['hello', 'world'])).toBe('hello world');
  });

  it('JSON-stringifies plain objects', () => {
    expect(formatLogArgs([{ a: 1 }])).toBe('{"a":1}');
  });

  it('exposes Error.message and name for top-level Error args', () => {
    const err = new TypeError('boom');
    const out = formatLogArgs(['caught:', err]);
    expect(out).toContain('TypeError: boom');
    expect(out.startsWith('caught: ')).toBe(true);
  });

  it('includes the stack trace for top-level Error args when present', () => {
    const err = new Error('with-stack');
    const out = formatLogArgs([err]);
    expect(out).toContain('Error: with-stack');
    if (err.stack) {
      expect(out).toContain(err.stack);
    }
  });

  it('exposes Error.message for Errors nested inside objects', () => {
    const err = new Error('nested-boom');
    const out = formatLogArgs([{ wrapped: err }]);
    expect(out).toContain('nested-boom');
  });

  it('joins mixed string + object + Error args with single spaces', () => {
    const err = new Error('mixed');
    const out = formatLogArgs(['Error rendering stream message:', err, { type: 'result' }]);
    expect(out).toContain('Error rendering stream message:');
    expect(out).toContain('Error: mixed');
    expect(out).toContain('"type":"result"');
  });
});
