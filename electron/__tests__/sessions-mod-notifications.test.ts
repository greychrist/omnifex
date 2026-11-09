import { describe, it, expect } from 'vitest';
import { createModNoticeTracker, MAX_DELAY_MS } from '../services/sessions/mod-notifications';

// The CLI's `system/ui_notify` and `ui_notify_cancel` frames (2.1.321), sent
// only because OmniFex spawns with CLAUDE_CODE_NOTIFICATIONS_HOST. The host
// raises the notification, holds a delayed one, replaces by (source, key) and
// takes one back on cancel or when the person returns.

const NOW = 1_800_000_000_000;

function frame(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'system', subtype: 'ui_notify',
    plugin: 'reminder', source: 'reminder@all-accounts',
    title: 'Stand up', text: 'Time to stretch',
    rewritten: false, uuid: 'u-1', session_id: 'sess-1',
    ...over,
  };
}

function tracker(now = NOW) {
  let t = now;
  const tr = createModNoticeTracker(() => t);
  return { tr, advance: (ms: number) => { t += ms; } };
}

describe('mod notices — notify', () => {
  it('raises an unkeyed frame now, under an id of its own', () => {
    const { tr } = tracker();
    expect(tr.notify(frame())).toEqual({
      id: 'mod:sess-1:u-1',
      title: 'Stand up',
      subtitle: 'From mod “reminder”',
      body: 'Time to stretch',
      deliverAt: null,
    });
  });

  it('gives a keyed frame an id from session, source and key, so the next one replaces it', () => {
    const { tr } = tracker();
    const a = tr.notify(frame({ key: 'k', uuid: 'u-1' }));
    const b = tr.notify(frame({ key: 'k', uuid: 'u-2' }));
    expect(a?.id).toBe('mod:sess-1:reminder@all-accounts:k');
    expect(b?.id).toBe(a?.id);
    // Another mod's same key is a different notification.
    expect(tr.notify(frame({ key: 'k', source: 'other@x' }))?.id).not.toBe(a?.id);
  });

  it('books delay_ms and at against the clock, capped at 7 days ahead', () => {
    const { tr } = tracker();
    expect(tr.notify(frame({ delay_ms: 60_000 }))?.deliverAt).toBe(NOW + 60_000);
    expect(tr.notify(frame({ at: NOW + 5_000 }))?.deliverAt).toBe(NOW + 5_000);
    expect(tr.notify(frame({ delay_ms: MAX_DELAY_MS * 2 }))?.deliverAt).toBe(NOW + MAX_DELAY_MS);
    // A moment already past is now.
    expect(tr.notify(frame({ at: NOW - 1 }))?.deliverAt).toBe(null);
    expect(tr.notify(frame({ delay_ms: 0 }))?.deliverAt).toBe(null);
  });

  it('says so when another mod rewrote the frame, and scrubs the plugin name', () => {
    const { tr } = tracker();
    const n = tr.notify(frame({ rewritten: true, plugin: 'rem\u0007inder\nX' }));
    expect(n?.subtitle).toBe('From mod “reminderX” · changed by another mod');
  });

  it('falls back to the plugin name for a missing title and refuses a frame without text', () => {
    const { tr } = tracker();
    expect(tr.notify(frame({ title: '' }))?.title).toBe('reminder');
    expect(tr.notify(frame({ text: undefined }))).toBeNull();
    expect(tr.notify(frame({ session_id: undefined }))).toBeNull();
  });
});

describe('mod notices — cancel', () => {
  it('takes back a keyed notification, shown or waiting, even one it never saw', () => {
    const { tr } = tracker();
    expect(tr.cancel({ source: 'reminder@all-accounts', key: 'k', session_id: 'sess-1' }))
      .toEqual(['mod:sess-1:reminder@all-accounts:k']);
  });

  it('without a key drops what that source still has waiting in this session, nothing else', () => {
    const { tr, advance } = tracker();
    const waiting = tr.notify(frame({ delay_ms: 60_000, uuid: 'a' }));
    tr.notify(frame({ uuid: 'b' })); // shown now: not waiting
    tr.notify(frame({ delay_ms: 60_000, uuid: 'c', source: 'other@x' }));
    const fired = tr.notify(frame({ delay_ms: 1_000, uuid: 'd' }));
    advance(2_000);
    const ids = tr.cancel({ source: 'reminder@all-accounts', session_id: 'sess-1' });
    expect(ids).toEqual([waiting?.id]);
    expect(ids).not.toContain(fired?.id);
    // Gone once dropped.
    expect(tr.cancel({ source: 'reminder@all-accounts', session_id: 'sess-1' })).toEqual([]);
  });

  it('refuses a cancel with no source', () => {
    const { tr } = tracker();
    expect(tr.cancel({ key: 'k', session_id: 'sess-1' })).toEqual([]);
  });
});

describe('mod notices — the person comes back', () => {
  it('withdraws waiting until_back notifications only', () => {
    const { tr } = tracker();
    const back = tr.notify(frame({ delay_ms: 60_000, until_back: true, uuid: 'a' }));
    tr.notify(frame({ delay_ms: 60_000, uuid: 'b' }));
    tr.notify(frame({ until_back: true, uuid: 'c' })); // no delay: until_back means nothing
    expect(tr.back()).toEqual([back?.id]);
    expect(tr.back()).toEqual([]);
  });

  it('leaves one that already fired', () => {
    const { tr, advance } = tracker();
    tr.notify(frame({ delay_ms: 1_000, until_back: true }));
    advance(1_001);
    expect(tr.back()).toEqual([]);
  });

  it('a keyed replacement without until_back stops the old one being withdrawn', () => {
    const { tr } = tracker();
    tr.notify(frame({ key: 'k', delay_ms: 60_000, until_back: true }));
    tr.notify(frame({ key: 'k', delay_ms: 60_000 }));
    expect(tr.back()).toEqual([]);
  });
});
