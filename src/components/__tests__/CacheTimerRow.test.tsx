// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { CacheTimerRow } from '../CacheTimerRow';
import { CACHE_TTL_5M_MS, CACHE_TTL_1H_MS } from '@/lib/cacheExpiry';

const ANCHOR = Date.parse('2026-07-30T10:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(ANCHOR);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const renderRow = (over: { ttlMs?: number | null; anchorMs?: number | null; busy?: boolean } = {}) =>
  render(
    <CacheTimerRow
      anchorMs={over.anchorMs === undefined ? ANCHOR : over.anchorMs}
      ttlMs={over.ttlMs === undefined ? CACHE_TTL_5M_MS : over.ttlMs}
      busy={over.busy ?? false}
    />,
  );

/** Advance the wall clock and let the row's interval fire. */
const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

describe('CacheTimerRow', () => {
  it('renders nothing when no turn has written cache', () => {
    const { container } = renderRow({ ttlMs: null });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing without an anchor', () => {
    const { container } = renderRow({ anchorMs: null });
    expect(container).toBeEmptyDOMElement();
  });

  it('counts down in muted type while fresh', () => {
    renderRow();
    const row = screen.getByText(/cache/);
    expect(row.textContent).toContain('5:00');
    expect(row.className).toContain('text-muted-foreground');
  });

  it('ticks once a second', () => {
    renderRow({ ttlMs: CACHE_TTL_5M_MS });
    advance(61_000);
    expect(screen.getByText(/cache/).textContent).toContain('3:59');
  });

  it('turns amber at 80% elapsed', () => {
    renderRow();
    advance(240_000); // 4:00 of a 5m TTL
    const row = screen.getByText(/cache/);
    expect(row.textContent).toContain('1:00');
    expect(row.className).toContain('amber');
  });

  it('turns red at 90% elapsed', () => {
    renderRow();
    advance(270_000); // 4:30
    const row = screen.getByText(/cache/);
    expect(row.className).toContain('red');
    expect(row.className).not.toContain('amber');
  });

  // The cost is already sunk at expiry, so a red alert would be nagging about
  // the past. It goes neutral and stops.
  it('goes neutral and says expired at 100%', () => {
    renderRow();
    advance(300_000);
    const row = screen.getByText(/cache/);
    expect(row.textContent).toContain('expired');
    expect(row.className).toContain('text-muted-foreground');
    expect(row.className).not.toContain('red');
  });

  it('stops ticking once expired', () => {
    renderRow();
    advance(300_000);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    advance(60_000);
    expect(screen.getByText(/cache/).textContent).toContain('expired');
    clearSpy.mockRestore();
  });

  // During a long turn the anchor is still the PREVIOUS assistant message, so a
  // 5m cache would read "expired" while a fresh write is actually in flight.
  it('shows a neutral refreshing state while a turn is in flight', () => {
    renderRow({ busy: true });
    advance(400_000);
    const row = screen.getByText(/cache/);
    expect(row.textContent).toContain('refreshing');
    expect(row.textContent).not.toContain('expired');
    expect(row.className).not.toContain('red');
  });

  // The TTL is visible in the row itself, not just the tooltip, so a 1h → 5m
  // drop is legible even if the change notice was missed.
  it('names the TTL inline', () => {
    renderRow({ ttlMs: CACHE_TTL_5M_MS });
    expect(screen.getByText(/cache/).textContent).toContain('5m');
  });

  it('names a 1h TTL inline', () => {
    renderRow({ ttlMs: CACHE_TTL_1H_MS });
    expect(screen.getByText(/cache/).textContent).toContain('1h');
  });

  it('handles a 1h TTL', () => {
    renderRow({ ttlMs: CACHE_TTL_1H_MS });
    expect(screen.getByText(/cache/).textContent).toContain('60m');
    advance(48 * 60_000);
    expect(screen.getByText(/cache/).className).toContain('amber');
  });
});
