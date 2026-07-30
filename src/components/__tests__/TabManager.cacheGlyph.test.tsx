import { describe, it, expect } from 'vitest';
import { resolveTabStatusIndicator } from '../TabManager';
import type { Tab } from '@/contexts/TabContext';
import { CACHE_TTL_5M_MS } from '@/lib/cacheExpiry';

const ANCHOR = Date.parse('2026-07-30T10:00:00Z');

const tab = (over: Partial<Tab> = {}): Tab =>
  ({
    id: 't1',
    type: 'chat',
    title: 'Session',
    status: 'idle',
    hasUnsavedChanges: false,
    order: 0,
    createdAt: new Date(ANCHOR),
    updatedAt: new Date(ANCHOR),
    ...over,
  }) as Tab;

/** A chat tab whose 5m cache was written at ANCHOR. */
const cacheTab = (over: Partial<Tab> = {}) =>
  tab({ cacheAnchorMs: ANCHOR, cacheTtlMs: CACHE_TTL_5M_MS, ...over });

const at = (secondsLater: number) => ANCHOR + secondsLater * 1000;

describe('resolveTabStatusIndicator — cache expiry', () => {
  it('shows nothing while the cache is fresh', () => {
    expect(resolveTabStatusIndicator(cacheTab(), at(100))).toBeNull();
  });

  it('appears at the warn step', () => {
    expect(resolveTabStatusIndicator(cacheTab(), at(240))).toEqual({
      kind: 'cacheExpiring',
      critical: false,
    });
  });

  it('goes critical at 90% elapsed', () => {
    expect(resolveTabStatusIndicator(cacheTab(), at(270))).toEqual({
      kind: 'cacheExpiring',
      critical: true,
    });
  });

  it('clears once expired — the cost is already sunk', () => {
    expect(resolveTabStatusIndicator(cacheTab(), at(300))).toBeNull();
    expect(resolveTabStatusIndicator(cacheTab(), at(9000))).toBeNull();
  });

  it('shows nothing when the timer is off or nothing has written cache', () => {
    expect(resolveTabStatusIndicator(tab(), at(240))).toBeNull();
    expect(
      resolveTabStatusIndicator(tab({ cacheAnchorMs: ANCHOR, cacheTtlMs: null }), at(240)),
    ).toBeNull();
  });
});

describe('resolveTabStatusIndicator — precedence', () => {
  it('loses to an error', () => {
    expect(resolveTabStatusIndicator(cacheTab({ status: 'error' }), at(270))).toEqual({
      kind: 'error',
    });
  });

  it('loses to a pending permission', () => {
    expect(
      resolveTabStatusIndicator(cacheTab({ waitingFor: 'permission' }), at(270)),
    ).toEqual({ kind: 'permission' });
  });

  it('loses to a waiting question', () => {
    expect(
      resolveTabStatusIndicator(cacheTab({ waitingFor: 'question' }), at(270)),
    ).toEqual({ kind: 'question' });
  });

  // A turn in flight is rewriting the cache, so the countdown is meaningless
  // until it lands — the spinner correctly wins.
  it('loses to the working spinner', () => {
    expect(
      resolveTabStatusIndicator(cacheTab({ promptStatus: 'working' }), at(270)),
    ).toEqual({ kind: 'spinner' });
  });

  it('loses to an unread result', () => {
    expect(
      resolveTabStatusIndicator(cacheTab({ hasUnreadResult: true }), at(270)),
    ).toEqual({ kind: 'complete' });
  });
});

describe('resolveTabStatusIndicator — existing behavior preserved', () => {
  it('still spins for a legacy running tab with no promptStatus', () => {
    expect(resolveTabStatusIndicator(tab({ status: 'running' }), at(0))).toEqual({
      kind: 'spinner',
    });
  });

  it('does not spin for a running tab that has published ready', () => {
    expect(
      resolveTabStatusIndicator(tab({ status: 'running', promptStatus: 'ready' }), at(0)),
    ).toBeNull();
  });

  it('returns null for a quiet tab', () => {
    expect(resolveTabStatusIndicator(tab(), at(0))).toBeNull();
  });
});
