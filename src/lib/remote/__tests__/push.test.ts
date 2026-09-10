import { describe, it, expect } from 'vitest';

import { deepLinkedSessionId, pushSupport } from '@/lib/remote/push';

describe('web push (client)', () => {
  it('reads the session id a notification tap lands on', () => {
    expect(deepLinkedSessionId('#session=abc-123')).toBe('abc-123');
    expect(deepLinkedSessionId('#foo=1&session=a%20b')).toBe('a b');
    expect(deepLinkedSessionId('#print=cost-report')).toBeNull();
    expect(deepLinkedSessionId('')).toBeNull();
  });

  it('reports unsupported outside a browser', () => {
    expect(pushSupport()).toBe('unsupported');
  });
});
