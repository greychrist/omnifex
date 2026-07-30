// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SessionNotices } from '../SessionNotices';
import { CACHE_TTL_1H_MS, CACHE_TTL_5M_MS } from '@/lib/cacheExpiry';

afterEach(() => {
  cleanup();
});

const JUMP = {
  deltaTokens: 325_000,
  prevTotal: 477_456,
  newTotal: 802_456,
  anchorId: 'p1',
};
const DROP = {
  fromMs: CACHE_TTL_1H_MS,
  toMs: CACHE_TTL_5M_MS,
};

const dismissJump = () =>
  fireEvent.click(screen.getByRole('button', { name: /dismiss context jump/i }));

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
  // loaded, so the only control offered is dismissal.
  it('offers no action other than dismissing', () => {
    render(<SessionNotices jump={JUMP} ttlChange={null} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByText(/compact/i)).toBeNull();
  });
});

describe('SessionNotices — dismissal', () => {
  it('hides the jump once dismissed', () => {
    const { container } = render(<SessionNotices jump={JUMP} ttlChange={null} />);
    dismissJump();
    expect(container).toBeEmptyDOMElement();
  });

  it('stays dismissed while the same turn keeps growing', () => {
    const { rerender } = render(<SessionNotices jump={JUMP} ttlChange={null} />);
    dismissJump();
    // Same prompt, more tokens — still the jump the user already waved off.
    rerender(
      <SessionNotices jump={{ ...JUMP, deltaTokens: 340_000, newTotal: 817_456 }} ttlChange={null} />,
    );
    expect(screen.queryByText(/added/)).toBeNull();
  });

  // The dismissal is keyed to the prompt, so the next big load still speaks up.
  it('reappears for a jump on a later prompt', () => {
    const { rerender } = render(<SessionNotices jump={JUMP} ttlChange={null} />);
    dismissJump();
    rerender(
      <SessionNotices jump={{ ...JUMP, anchorId: 'p2', deltaTokens: 90_000 }} ttlChange={null} />,
    );
    expect(screen.getByText(/added/)).toBeInTheDocument();
  });

  it('dismisses the two notices independently', () => {
    render(<SessionNotices jump={JUMP} ttlChange={DROP} />);
    dismissJump();
    expect(screen.queryByText(/added/)).toBeNull();
    expect(screen.getByText(/prompt cache TTL/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /dismiss cache ttl/i }));
    expect(screen.queryByText(/prompt cache TTL/i)).toBeNull();
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
        ttlChange={{ fromMs: CACHE_TTL_5M_MS, toMs: CACHE_TTL_1H_MS }}
      />,
    );
    expect(screen.getByText(/cache/i).textContent ?? '').not.toMatch(/overage/i);
  });

  // Previously this self-cleared once a later turn confirmed the new TTL, which
  // meant it could vanish before it was read. It now behaves like the other
  // banners: it stays until dismissed.
  it('stays visible after a later turn confirms the new TTL', () => {
    render(<SessionNotices jump={null} ttlChange={DROP} />);
    expect(screen.getByText(/prompt cache TTL/i)).toBeInTheDocument();
  });

  it('can be dismissed once it has gone stale', () => {
    const { container } = render(
      <SessionNotices jump={null} ttlChange={DROP} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /dismiss cache ttl/i }));
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
