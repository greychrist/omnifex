// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SessionNotices } from '../SessionNotices';
import { CACHE_TTL_1H_MS, CACHE_TTL_5M_MS } from '@/lib/cacheExpiry';

afterEach(() => {
  cleanup();
});

const JUMP = { deltaTokens: 325_000, prevTotal: 477_456, newTotal: 802_456 };
const DROP = {
  fromMs: CACHE_TTL_1H_MS,
  toMs: CACHE_TTL_5M_MS,
  isMostRecentWrite: true,
};

describe('SessionNotices — context jump', () => {
  it('reports the size of the jump and where it landed', () => {
    render(<SessionNotices jump={JUMP} ttlChange={null} />);
    const text = screen.getByText(/added/).textContent ?? '';
    expect(text).toContain('325k');
    expect(text).toContain('477k');
    expect(text).toContain('802k');
  });

  it('renders nothing without a jump', () => {
    const { container } = render(<SessionNotices jump={null} ttlChange={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  // Compacting right after a big load would throw away the thing that was just
  // loaded, so this notice deliberately reports rather than offering an action.
  it('is not actionable', () => {
    render(<SessionNotices jump={JUMP} ttlChange={null} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('SessionNotices — TTL change', () => {
  it('names both TTLs and the likely cause of a drop', () => {
    render(<SessionNotices jump={null} ttlChange={DROP} />);
    const text = screen.getByText(/cache/i).textContent ?? '';
    expect(text).toContain('1h');
    expect(text).toContain('5m');
    expect(text).toMatch(/overage/i);
  });

  it('does not blame overage when the TTL recovered', () => {
    render(
      <SessionNotices
        jump={null}
        ttlChange={{ fromMs: CACHE_TTL_5M_MS, toMs: CACHE_TTL_1H_MS, isMostRecentWrite: true }}
      />,
    );
    expect(screen.getByText(/cache/i).textContent ?? '').not.toMatch(/overage/i);
  });

  it('goes quiet once the change is no longer the newest write', () => {
    const { container } = render(
      <SessionNotices jump={null} ttlChange={{ ...DROP, isMostRecentWrite: false }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('SessionNotices — stacking', () => {
  it('shows both notices at once when both apply', () => {
    render(<SessionNotices jump={JUMP} ttlChange={DROP} />);
    expect(screen.getByText(/added/)).toBeInTheDocument();
    expect(screen.getByText(/prompt cache TTL/i)).toBeInTheDocument();
  });
});
