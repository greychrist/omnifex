// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SessionStatusBar } from '../SessionStatusBar';
import type { SessionSignal } from '@/lib/signals/types';

afterEach(() => { cleanup(); });

const signal = (meta: Record<string, unknown>): SessionSignal =>
  ({
    id: 'session.activity',
    tabId: 'tab-1',
    kind: 'state',
    anchor: 'session',
    priority: 'low',
    key: 'session.activity',
    title: String(meta.status ?? ''),
    at: 0,
    meta,
  }) as unknown as SessionSignal;

describe('SessionStatusBar', () => {
  it('shows a working glyph with elapsed time while a turn is in flight', () => {
    render(
      <SessionStatusBar
        activeSubagents={0}
        activitySignal={signal({ status: 'active', turnStartedAt: Date.now() - 84_000 })}
      />,
    );
    expect(screen.getByLabelText(/^working/i)).toBeTruthy();
    expect(screen.getByText('1:24')).toBeTruthy();
  });

  it('freezes on the previous round when idle', () => {
    render(
      <SessionStatusBar
        activeSubagents={0}
        activitySignal={signal({
          status: 'idle',
          turnStartedAt: null,
          lastTurnMs: 84_000,
          lastThinkingTokens: 12_400,
        })}
      />,
    );
    expect(screen.getByText('1:24')).toBeTruthy();
    expect(screen.getByText('12.4k')).toBeTruthy();
  });

  it('does not pulse when idle', () => {
    render(
      <SessionStatusBar
        activeSubagents={0}
        activitySignal={signal({ status: 'idle', lastTurnMs: 1000 })}
      />,
    );
    expect(screen.getByLabelText(/^working/i).className).not.toContain('animate-pulse');
  });

  it('pulses the working glyph while a turn runs', () => {
    render(
      <SessionStatusBar
        activeSubagents={0}
        activitySignal={signal({ status: 'active', turnStartedAt: Date.now() })}
      />,
    );
    expect(screen.getByLabelText(/^working/i).className).toContain('animate-pulse');
  });

  it('pulses the thinking glyph while a burst is open', () => {
    render(
      <SessionStatusBar
        activeSubagents={0}
        activitySignal={signal({
          status: 'thinking',
          thinkingTokens: 900,
          turnStartedAt: Date.now(),
        })}
      />,
    );
    expect(screen.getByLabelText(/^thinking/i).className).toContain('animate-pulse');
  });

  it('shows the live thinking total in preference to the frozen one', () => {
    render(
      <SessionStatusBar
        activeSubagents={0}
        activitySignal={signal({
          status: 'thinking',
          thinkingTokens: 900,
          lastThinkingTokens: 12_400,
          turnStartedAt: Date.now(),
        })}
      />,
    );
    expect(screen.getByText('900')).toBeTruthy();
    expect(screen.queryByText('12.4k')).toBeNull();
  });

  it('shows the subagent glyph only when agents are running', () => {
    const { rerender } = render(
      <SessionStatusBar
        activeSubagents={0}
        activitySignal={signal({ status: 'idle', lastTurnMs: 1000 })}
      />,
    );
    expect(screen.queryByLabelText(/background agent/i)).toBeNull();

    rerender(
      <SessionStatusBar
        activeSubagents={3}
        activitySignal={signal({ status: 'active', turnStartedAt: Date.now() })}
      />,
    );
    expect(screen.getByLabelText(/3 background agents working/i)).toBeTruthy();
  });

  it('renders nothing at all for a session that has never run a turn', () => {
    const { container } = render(
      <SessionStatusBar activeSubagents={0} activitySignal={signal({ status: 'idle' })} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing without a signal', () => {
    const { container } = render(<SessionStatusBar activeSubagents={0} />);
    expect(container.innerHTML).toBe('');
  });

  it('omits the thinking glyph for a turn that never thought', () => {
    render(
      <SessionStatusBar
        activeSubagents={0}
        activitySignal={signal({ status: 'active', turnStartedAt: Date.now() })}
      />,
    );
    expect(screen.getByLabelText(/^working/i)).toBeTruthy();
    expect(screen.queryByLabelText(/^thinking/i)).toBeNull();
  });

  it('still reports agents when the turn itself has no clock yet', () => {
    render(
      <SessionStatusBar
        activeSubagents={2}
        activitySignal={signal({ status: 'idle' })}
      />,
    );
    expect(screen.queryByLabelText(/^working/i)).toBeNull();
    expect(screen.getByLabelText(/2 background agents working/i)).toBeTruthy();
  });
});
