import { describe, it, expect } from 'vitest';
import type { Account, ResolveSlot } from '@/lib/api';
import { slotToResolution } from '@/lib/accountResolution';

const slot = (name: string): ResolveSlot => ({
  account: {
    id: 1,
    name,
    config_dir: '/Users/x/.claude-personal',
    engine: 'claude',
    subscription_label: 'Max',
    has_cost: false,
  } as Account,
  matchType: 'path_rule',
  matchDetail: '/Users/x/Repos',
});

describe('slotToResolution', () => {
  it('maps a routing slot onto the session-header resolution shape', () => {
    expect(slotToResolution(slot('work'))).toMatchObject({
      account: { name: 'work', config_dir: '/Users/x/.claude-personal' },
      match_type: 'path_rule',
      match_detail: '/Users/x/Repos',
    });
  });

  it('returns null for an engine with no matching rule', () => {
    // Callers must NOT fall back to the other engine's slot — that lands a
    // Claude session on a Codex account.
    expect(slotToResolution(null)).toBeNull();
    expect(slotToResolution(undefined)).toBeNull();
  });
});
