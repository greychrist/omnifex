// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { announceAccountSignedIn, onAccountSignedIn } from '../accountSignIn';

describe('account sign-in broadcast', () => {
  it('tells every listener which config dir was signed in', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onAccountSignedIn(a);
    const offB = onAccountSignedIn(b);
    announceAccountSignedIn('/Users/me/.claude-personal');
    expect(a).toHaveBeenCalledWith('/Users/me/.claude-personal');
    expect(b).toHaveBeenCalledWith('/Users/me/.claude-personal');
    offA();
    offB();
  });

  it('stops notifying a listener once it unsubscribes', () => {
    const a = vi.fn();
    const off = onAccountSignedIn(a);
    off();
    announceAccountSignedIn('/Users/me/.claude-personal');
    expect(a).not.toHaveBeenCalled();
  });
});
