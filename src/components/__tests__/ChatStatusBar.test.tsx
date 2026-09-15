// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { ChatStatusBar, LinkGlyph } from '@/components/ChatStatusBar';
import type { SessionSignal } from '@/lib/signals/types';

const signal = (meta: Record<string, unknown>): SessionSignal =>
  ({ meta } as unknown as SessionSignal);

const base = {
  link: { connection: 'connected' as const, delivering: true },
  cacheAnchorMs: null,
  cacheTtlMs: null,
  cacheBusy: false,
};

afterEach(() => { cleanup(); });

describe('LinkGlyph', () => {
  // A coloured wifi icon on its own says "something about the network"; which
  // something is the whole point.
  it('says in words which state it is in', () => {
    const cases = [
      [{ connection: 'connected' as const, delivering: true }, 'live'],
      [{ connection: 'connected' as const, delivering: false }, 'no events'],
      [{ connection: 'reconnecting' as const, delivering: false }, 'reconnecting'],
      [{ connection: 'disconnected' as const, delivering: false }, 'offline'],
    ] as const;
    for (const [state, word] of cases) {
      const { unmount } = render(<LinkGlyph {...state} />);
      // Named subject, then state — otherwise "live" alone is live *what*.
      expect(screen.getByText('daemon')).toBeTruthy();
      expect(screen.getByText(word)).toBeTruthy();
      unmount();
    }
  });

  // The distinction the outage turned on: the socket was up the whole time.
  it('separates "connected" from "connected but this session is not receiving"', () => {
    const { unmount } = render(<LinkGlyph connection="connected" delivering />);
    expect(screen.getByLabelText('connected')).toBeTruthy();
    unmount();

    render(<LinkGlyph connection="connected" delivering={false} />);
    expect(screen.queryByLabelText('connected')).toBeNull();
    expect(screen.getByLabelText('connected, session not receiving')).toBeTruthy();
  });

  it('reports a dropped socket, and a reconnecting one differently', () => {
    const { unmount } = render(<LinkGlyph connection="disconnected" delivering={false} />);
    expect(screen.getByLabelText('disconnected from daemon')).toBeTruthy();
    unmount();

    render(<LinkGlyph connection="reconnecting" delivering={false} />);
    expect(screen.getByLabelText('reconnecting to daemon')).toBeTruthy();
  });

  // Legacy IPC has no daemon; a permanent red "disconnected" would be a lie.
  it('renders nothing when there is no daemon on this page', () => {
    const { container } = render(<LinkGlyph connection={null} delivering={false} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('ChatStatusBar', () => {
  it('shows the turn clock and the thinking burst', () => {
    render(
      <ChatStatusBar
        {...base}
        activitySignal={signal({ status: 'thinking', turnStartedAt: null, lastTurnMs: 12_000, thinkingTokens: 12_400 })}
      />,
    );
    expect(screen.getByLabelText('working — last round').textContent).toContain('12');
    expect(screen.getByLabelText('thinking').textContent).toContain('12.4k');
  });

  // Both readouts hold the previous round's value, so an idle session still
  // answers "how long did that take, and how much did it think?"
  it('keeps the previous round on screen once the turn ends', () => {
    render(
      <ChatStatusBar
        {...base}
        activitySignal={signal({ status: 'idle', turnStartedAt: null, lastTurnMs: 3_000, lastThinkingTokens: 800 })}
      />,
    );
    expect(screen.getByLabelText('working — last round')).toBeTruthy();
    expect(screen.getByLabelText('thinking — last burst').textContent).toContain('800');
  });

  it('omits each readout until it has a number, but still renders the bar', () => {
    render(<ChatStatusBar {...base} />);
    expect(screen.getByTestId('chat-status-bar')).toBeTruthy();
    expect(screen.queryByLabelText(/working/)).toBeNull();
    expect(screen.queryByLabelText(/thinking/)).toBeNull();
  });

  // Pulse marks "this is happening right now" — the frozen previous-round
  // readouts must not claim it.
  it('pulses each glyph only while its own thing is live', () => {
    const { unmount } = render(
      <ChatStatusBar {...base} activitySignal={signal({ status: 'idle', lastTurnMs: 1000 })} />,
    );
    expect(screen.getByLabelText(/^working/i).className).not.toContain('animate-pulse');
    unmount();

    render(
      <ChatStatusBar
        {...base}
        activitySignal={signal({ status: 'thinking', turnStartedAt: Date.now(), thinkingTokens: 900 })}
      />,
    );
    expect(screen.getByLabelText(/^working/i).className).toContain('animate-pulse');
    expect(screen.getByLabelText(/^thinking/i).className).toContain('animate-pulse');
  });

  // Mid-burst the frozen value is the PREVIOUS burst, so showing it would be
  // stale by a whole round.
  it('shows the live thinking total in preference to the frozen one', () => {
    render(
      <ChatStatusBar
        {...base}
        activitySignal={signal({
          status: 'thinking', thinkingTokens: 900, lastThinkingTokens: 12_400, turnStartedAt: Date.now(),
        })}
      />,
    );
    expect(screen.getByText('900')).toBeTruthy();
    expect(screen.queryByText('12.4k')).toBeNull();
  });

  it('omits the thinking glyph for a turn that never thought', () => {
    render(
      <ChatStatusBar {...base} activitySignal={signal({ status: 'active', turnStartedAt: Date.now() })} />,
    );
    expect(screen.getByLabelText(/^working/i)).toBeTruthy();
    expect(screen.queryByLabelText(/^thinking/i)).toBeNull();
  });

  it('labels each readout, not just its icon', () => {
    render(
      <ChatStatusBar
        {...base}
        activitySignal={signal({ status: 'idle', turnStartedAt: null, lastTurnMs: 3_000, lastThinkingTokens: 800 })}
      />,
    );
    expect(screen.getByText('daemon')).toBeTruthy();
    expect(screen.getByText('live')).toBeTruthy();
    expect(screen.getByText('turn')).toBeTruthy();
    expect(screen.getByText('thinking')).toBeTruthy();
  });

  it('puts a separator strictly between readouts, never at either end', () => {
    // Four readouts → three dividers.
    const { unmount } = render(
      <ChatStatusBar
        {...base}
        activitySignal={signal({ status: 'idle', lastTurnMs: 3_000, lastThinkingTokens: 800 })}
        cacheAnchorMs={Date.now() - 60_000}
        cacheTtlMs={5 * 60_000}
      />,
    );
    expect(screen.getAllByTestId('status-divider')).toHaveLength(3);
    unmount();

    // One readout → no divider. Hard-coded separators would leave a stray
    // hairline hanging off a half-empty bar.
    render(<ChatStatusBar {...base} />);
    expect(screen.queryAllByTestId('status-divider')).toHaveLength(0);
  });

  // The bar drops the link glyph entirely on a page with no daemon, so the
  // divider count has to follow what actually rendered.
  it('counts no divider for a readout that is not there', () => {
    render(
      <ChatStatusBar
        {...base}
        link={{ connection: null, delivering: false }}
        activitySignal={signal({ status: 'idle', lastTurnMs: 3_000 })}
      />,
    );
    expect(screen.queryByText('live')).toBeNull();
    expect(screen.queryAllByTestId('status-divider')).toHaveLength(0);
  });

  it('carries the cache countdown', () => {
    render(
      <ChatStatusBar
        {...base}
        cacheAnchorMs={Date.now() - 60_000}
        cacheTtlMs={5 * 60_000}
        cacheBusy={false}
      />,
    );
    expect(screen.getByText(/cache .* left \(5m\)/)).toBeTruthy();
  });
});
