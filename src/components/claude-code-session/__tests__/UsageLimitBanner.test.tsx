// @vitest-environment jsdom
//
// Claude Code 2.1.234's `autoContinueAtUsageLimit` (default ON for claude.ai
// logins) parks a limited session until the limit resets instead of ending the
// turn. The turn really is still in flight, so the composer keeps spinning —
// for hours. This banner is the only thing that says why.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { UsageLimitBanner } from '../UsageLimitBanner';

afterEach(() => { cleanup(); });

// 2026-08-18T18:00:00Z in epoch SECONDS, which is how the CLI emits resetsAt.
const RESETS_AT = Math.floor(Date.UTC(2026, 7, 18, 18, 0, 0) / 1000);
const NOW_MS = Date.UTC(2026, 7, 18, 15, 45, 0);

describe('UsageLimitBanner', () => {
  it('renders nothing when the session is not parked on a limit', () => {
    const { container } = render(<UsageLimitBanner resetsAt={null} nowMs={NOW_MS} />);
    expect(container.textContent).toBe('');
  });

  it('says the usage limit was reached', () => {
    const { container } = render(<UsageLimitBanner resetsAt={RESETS_AT} nowMs={NOW_MS} />);
    expect(container.textContent).toContain('Usage limit reached');
  });

  it('shows how long is left until the reset', () => {
    const { container } = render(<UsageLimitBanner resetsAt={RESETS_AT} nowMs={NOW_MS} />);
    expect(container.textContent).toContain('2h 15m');
  });

  it('shows the reset clock time', () => {
    const { container } = render(<UsageLimitBanner resetsAt={RESETS_AT} nowMs={NOW_MS} />);
    const expected = new Date(RESETS_AT * 1000).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
    expect(container.textContent).toContain(expected);
  });

  it('renders minutes alone when the reset is under an hour away', () => {
    const { container } = render(
      <UsageLimitBanner resetsAt={RESETS_AT} nowMs={(RESETS_AT - 12 * 60) * 1000} />,
    );
    expect(container.textContent).toContain('12m');
    expect(container.textContent).not.toContain('h ');
  });

  it('says the reset is due rather than counting backwards once it has passed', () => {
    const { container } = render(
      <UsageLimitBanner resetsAt={RESETS_AT} nowMs={(RESETS_AT + 300) * 1000} />,
    );
    expect(container.textContent).toContain('any moment');
    expect(container.textContent).not.toContain('-');
  });
});
