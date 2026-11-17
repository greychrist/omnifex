import { describe, it, expect, vi } from 'vitest';
import { createDraftActivityPinger, DRAFT_ACTIVITY_INTERVAL_MS } from '../promptDraftActivity';

// The CLI asks for one ping at the first key and about one every 10 s while
// typing goes on (prompt_draft_activity, 2.1.326).
describe('createDraftActivityPinger', () => {
  it('pings at the first key, then at most once per interval', () => {
    let now = 1_000;
    const send = vi.fn();
    const ping = createDraftActivityPinger(send, () => now);
    ping('tab1');
    ping('tab1');
    now += DRAFT_ACTIVITY_INTERVAL_MS - 1;
    ping('tab1');
    expect(send).toHaveBeenCalledTimes(1);
    now += 1;
    ping('tab1');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('tab1');
  });

  it('keeps a separate clock per tab', () => {
    const send = vi.fn();
    const ping = createDraftActivityPinger(send, () => 5);
    ping('a');
    ping('b');
    ping('a');
    expect(send.mock.calls).toEqual([['a'], ['b']]);
  });

  it('ignores an empty tab id', () => {
    const send = vi.fn();
    createDraftActivityPinger(send, () => 0)('');
    expect(send).not.toHaveBeenCalled();
  });

  it('swallows a rejected send', async () => {
    const send = vi.fn(() => Promise.reject(new Error('older CLI')));
    const ping = createDraftActivityPinger(send, () => 0);
    expect(() => ping('tab1')).not.toThrow();
    await Promise.resolve();
  });
});
