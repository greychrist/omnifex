import { describe, it, expect } from 'vitest';
import { validateSessionId } from '../sessionId';

describe('validateSessionId', () => {
  it('accepts a canonical lowercase UUID', () => {
    const result = validateSessionId('ddd97773-3a21-4670-85d4-970dad963e1a');
    expect(result).toEqual({ ok: true, id: 'ddd97773-3a21-4670-85d4-970dad963e1a' });
  });

  it('lowercases an uppercase UUID', () => {
    const result = validateSessionId('DDD97773-3A21-4670-85D4-970DAD963E1A');
    expect(result).toEqual({ ok: true, id: 'ddd97773-3a21-4670-85d4-970dad963e1a' });
  });

  it('trims surrounding whitespace', () => {
    const result = validateSessionId('  ddd97773-3a21-4670-85d4-970dad963e1a\n');
    expect(result).toEqual({ ok: true, id: 'ddd97773-3a21-4670-85d4-970dad963e1a' });
  });

  it('rejects empty input', () => {
    const result = validateSessionId('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Paste');
  });

  it('rejects whitespace-only input', () => {
    const result = validateSessionId('   ');
    expect(result.ok).toBe(false);
  });

  it('rejects a UUID with the wrong segment lengths', () => {
    const result = validateSessionId('ddd97773-3a21-4670-85d4-970dad963e1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('GUID');
  });

  it('rejects a UUID with non-hex characters', () => {
    const result = validateSessionId('zzz97773-3a21-4670-85d4-970dad963e1a');
    expect(result.ok).toBe(false);
  });

  it('rejects free-form text', () => {
    const result = validateSessionId('not a session id at all');
    expect(result.ok).toBe(false);
  });

  it('rejects a UUID without dashes', () => {
    const result = validateSessionId('ddd977733a21467085d4970dad963e1a');
    expect(result.ok).toBe(false);
  });
});
