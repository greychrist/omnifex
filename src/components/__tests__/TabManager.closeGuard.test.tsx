import { describe, it, expect } from 'vitest';
import { tabCloseNeedsConfirm } from '../TabManager';
import type { Tab } from '@/contexts/TabContext';
import { CACHE_TTL_5M_MS } from '@/lib/cacheExpiry';

const ANCHOR = Date.parse('2026-09-15T10:00:00Z');

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

/**
 * Closing a tab is the one path that tears down the main-process CLI session
 * (TabContext.removeTab → api.stopSession), so it must not happen by accident
 * while the session still has work in it.
 *
 * The predicate is derived from `resolveTabStatusIndicator` rather than
 * re-reading `promptStatus` / `activeAgents` / `waitingFor` itself: the tab
 * strip already decides what a tab is doing, and a second opinion on the same
 * fields is exactly the kind of drift this repo keeps paying for.
 */
describe('tabCloseNeedsConfirm', () => {
  it('lets an idle tab close without asking', () => {
    expect(tabCloseNeedsConfirm(tab(), ANCHOR)).toBe(false);
  });

  it('asks when the agent is mid-turn', () => {
    expect(tabCloseNeedsConfirm(tab({ promptStatus: 'working' }), ANCHOR)).toBe(true);
  });

  it('asks for a legacy running tab that never published promptStatus', () => {
    expect(tabCloseNeedsConfirm(tab({ status: 'running' }), ANCHOR)).toBe(true);
  });

  it('asks when subagents are still running', () => {
    expect(tabCloseNeedsConfirm(tab({ activeAgents: 2 }), ANCHOR)).toBe(true);
  });

  // A pending permission keeps the turn open — the session is blocked on the
  // human, so the work is very much unfinished.
  it('asks when the session is blocked on a permission prompt', () => {
    expect(tabCloseNeedsConfirm(tab({ waitingFor: 'permission' }), ANCHOR)).toBe(true);
  });

  it('asks when the session is blocked on a question', () => {
    expect(tabCloseNeedsConfirm(tab({ waitingFor: 'question' }), ANCHOR)).toBe(true);
  });

  // The lifecycle doc is explicit that an errored session is NOT in flight,
  // and `error` outranks everything in the glyph precedence. Nothing is
  // running, so nothing is lost.
  it('does not ask for an errored tab', () => {
    expect(tabCloseNeedsConfirm(tab({ status: 'error', promptStatus: 'working' }), ANCHOR)).toBe(false);
  });

  // An unread result means the turn already finished. Closing discards a
  // notification, not work.
  it('does not ask for a finished tab with an unread result', () => {
    expect(tabCloseNeedsConfirm(tab({ hasUnreadResult: true }), ANCHOR)).toBe(false);
  });

  // Ambient cost hint on an idle background session — not work in progress.
  it('does not ask just because the prompt cache is expiring', () => {
    const t = tab({ cacheAnchorMs: ANCHOR, cacheTtlMs: CACHE_TTL_5M_MS });
    expect(tabCloseNeedsConfirm(t, ANCHOR + 270_000)).toBe(false);
  });

  it('does not ask for a non-chat tab', () => {
    expect(tabCloseNeedsConfirm(tab({ type: 'projects' as Tab['type'] }), ANCHOR)).toBe(false);
  });
});
