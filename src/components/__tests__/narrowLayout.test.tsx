// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

// The one input that decides all of this. Mocked rather than driven through
// window.innerWidth because useLayoutMode caches its value in module state
// shared by every test in the file.
const layout = { narrow: false, touch: false, web: false };
vi.mock('@/hooks/useLayoutMode', () => ({ useLayoutMode: () => layout }));

import { SessionCard } from '@/components/SessionCard';
import { RateLimitWidget } from '@/components/claude-code-session/RateLimitWidget';
import type { SessionContextUsage, RateLimitSnapshot } from '@/lib/api';

const USAGE: SessionContextUsage = {
  totalTokens: 12_000,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  percentage: 6,
  model: 'sonnet',
  categories: [],
};

const SNAPSHOT = {
  status: 'allowed',
  utilization: 42,
  resets_at: Math.floor(Date.now() / 1000) + 3600,
  observed_at: Date.now(),
} as unknown as RateLimitSnapshot;

beforeEach(() => { layout.narrow = false; });
afterEach(() => { cleanup(); });

describe('narrow windows drop the meter bars', () => {
  it('keeps the session widget bar at full width and drops it when narrow', () => {
    const { unmount } = render(<SessionCard totalTokens={12_000} contextLimit={200_000} contextUsage={USAGE} />);
    expect(screen.getByTestId('context-meter-bar')).toBeTruthy();
    // The numbers either side of it stay — they carry the same fact.
    expect(screen.getByText('12.0k')).toBeTruthy();
    unmount();

    layout.narrow = true;
    render(<SessionCard totalTokens={12_000} contextLimit={200_000} contextUsage={USAGE} />);
    expect(screen.queryByTestId('context-meter-bar')).toBeNull();
    expect(screen.getByText('12.0k')).toBeTruthy();
    expect(screen.getByText('6%')).toBeTruthy();
    // The bar was also what kept those two numbers apart.
    expect(screen.getByTestId('context-meter-divider')).toBeTruthy();
  });

  it('shows no divider while the bar itself is doing the separating', () => {
    render(<SessionCard totalTokens={12_000} contextLimit={200_000} contextUsage={USAGE} />);
    expect(screen.getByTestId('context-meter-bar')).toBeTruthy();
    expect(screen.queryByTestId('context-meter-divider')).toBeNull();
  });

  it('drops the rate-limit bar when narrow, keeping the percentage', () => {
    const { unmount } = render(<RateLimitWidget snapshot={SNAPSHOT} windowType="five_hour" />);
    expect(screen.getByTestId('rate-limit-bar')).toBeTruthy();
    unmount();

    layout.narrow = true;
    render(<RateLimitWidget snapshot={SNAPSHOT} windowType="five_hour" />);
    expect(screen.queryByTestId('rate-limit-bar')).toBeNull();
    expect(screen.getByText('42%')).toBeTruthy();
    // Otherwise the percentage runs straight into the reset countdown.
    expect(screen.getByTestId('rate-limit-divider')).toBeTruthy();
  });

  it('swaps the bar for a divider rather than showing both', () => {
    render(<RateLimitWidget snapshot={SNAPSHOT} windowType="five_hour" />);
    expect(screen.getByTestId('rate-limit-bar')).toBeTruthy();
    expect(screen.queryByTestId('rate-limit-divider')).toBeNull();
  });

  // The empty state carries a placeholder bar of the same width.
  it('drops the placeholder bar too, so an account with no data still fits', () => {
    layout.narrow = true;
    render(<RateLimitWidget snapshot={null} windowType="seven_day" />);
    expect(screen.queryByTestId('rate-limit-bar')).toBeNull();
    expect(screen.getByTestId('rate-limit-divider')).toBeTruthy();
  });
});
