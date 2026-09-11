// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SessionCard } from '../SessionCard';
import type { SessionContextUsage } from '@/lib/api';

afterEach(() => { cleanup(); });

const USAGE: SessionContextUsage = {
  totalTokens: 12_000,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  percentage: 6,
  model: 'sonnet',
  categories: [],
};

describe('SessionCard — context popover controls', () => {
  it('renders the injected session controls inside the context popover', () => {
    render(
      <SessionCard
        totalTokens={12_000}
        model="sonnet"
        contextUsage={USAGE}
        sessionStatus="active"
        controls={<div data-testid="session-controls" />}
      />,
    );

    // Closed: controls are not in the document.
    expect(screen.queryByTestId('session-controls')).toBeNull();

    // Open the context popover via its trigger (shows the token count).
    fireEvent.click(screen.getByText('12.0k'));
    expect(screen.getByTestId('session-controls')).toBeTruthy();
    expect(screen.getByText('Context')).toBeTruthy();
  });

  it('sizes a 1M Account-Default session against 1M in the client-side fallback', () => {
    // The reported bug: a resumed chat-mode "Account Default" session (history
    // loaded statically, so live contextUsage hasn't been fetched) whose own
    // model string carries no [1m] suffix. Without the account default it was
    // pinned to 200k → 181.9k read as 91%. With the account default ("opus[1m]")
    // the gauge sizes against 1M → ~18%.
    render(
      <SessionCard
        totalTokens={181_886}
        model="claude-opus-4-8"
        defaultModel="opus[1m]"
        sessionStatus="active"
      />,
    );
    expect(screen.getByText('18%')).toBeTruthy();
    expect(screen.queryByText('91%')).toBeNull();
  });

  it('still pins to 200k when no live usage and no 1M account default (regression guard)', () => {
    render(
      <SessionCard
        totalTokens={181_886}
        model="claude-opus-4-8"
        sessionStatus="active"
      />,
    );
    expect(screen.getByText('91%')).toBeTruthy();
  });

  it('renders the active-controls summary above the context gauge', () => {
    render(
      <SessionCard
        totalTokens={12_000}
        model="sonnet"
        contextUsage={USAGE}
        sessionStatus="active"
        controlsSummary="Fable 5 | High | Auto Review"
      />,
    );
    expect(screen.getByText('Fable 5 | High | Auto Review')).toBeTruthy();
  });

  it('renders no summary text when none is provided', () => {
    render(
      <SessionCard
        totalTokens={12_000}
        model="sonnet"
        contextUsage={USAGE}
        sessionStatus="active"
      />,
    );
    expect(screen.queryByText(/\|/)).toBeNull();
  });

  it('stretches the context gauge to fill available width', () => {
    render(
      <SessionCard
        totalTokens={12_000}
        model="sonnet"
        contextUsage={USAGE}
        sessionStatus="active"
      />,
    );
    const trigger = screen.getByText('12.0k').closest('button')!;
    expect(trigger.className).toContain('w-full');
    // The progress track grows with the trigger instead of a fixed width.
    const track = trigger.querySelector('.flex-1');
    expect(track).toBeTruthy();
    expect(trigger.querySelector('.w-11')).toBeNull();
  });

  it('renders no controls section when none are provided', () => {
    render(
      <SessionCard
        totalTokens={12_000}
        model="sonnet"
        contextUsage={USAGE}
        sessionStatus="active"
      />,
    );
    fireEvent.click(screen.getByText('12.0k'));
    expect(screen.queryByTestId('session-controls')).toBeNull();
    expect(screen.getByText('Context')).toBeTruthy();
  });
});

const WITH_CATEGORIES: SessionContextUsage = {
  ...USAGE,
  totalTokens: 120_000,
  categories: [
    { name: 'System prompt', tokens: 20_000, color: '#fff' },
    { name: 'Tools', tokens: 40_000, color: '#fff' },
    { name: 'Messages', tokens: 60_000, color: '#fff' },
  ],
} as SessionContextUsage;

const openPopover = () => {
  fireEvent.click(screen.getByRole('button', { name: /context/i }));
};

describe('SessionCard — compact button', () => {
  // The refactor that removed the context-pressure banner took the only
  // always-visible compact affordance with it: the action signal fires at 100%
  // of budget, so between 80% and 100% there was an amber meter and nothing to
  // click. The popover now carries a permanent one at any level.
  it('offers Compact now at any context level', () => {
    render(<SessionCard totalTokens={12_000} contextUsage={USAGE} onCompact={() => {}} />);
    openPopover();

    expect(screen.getByRole('button', { name: 'Compact now' })).toBeTruthy();
  });

  it('runs the handler when pressed', () => {
    let ran = 0;
    render(<SessionCard totalTokens={12_000} contextUsage={USAGE} onCompact={() => { ran += 1; }} />);
    openPopover();

    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }));
    expect(ran).toBe(1);
  });

  it('goes inert while a turn is in flight, rather than vanishing', () => {
    render(
      <SessionCard totalTokens={12_000} contextUsage={USAGE} onCompact={() => {}} compactDisabled />,
    );
    openPopover();

    // No jest-dom in this file; assert the DOM property directly.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Compact now' }).disabled).toBe(true);
  });

  it('yields to the pending action card rather than offering compact twice', () => {
    const pending = {
      id: 'context.boundary',
      tabId: 't1',
      kind: 'action' as const,
      anchor: 'session' as const,
      priority: 'high' as const,
      key: 'context.boundary',
      title: 'Context past your 250k budget',
      at: 0,
      actions: [{ id: 'compact', label: 'Compact now', primary: true, run: () => {} }],
    };

    render(
      <SessionCard
        totalTokens={12_000}
        contextUsage={USAGE}
        onCompact={() => {}}
        pendingAction={pending}
      />,
    );
    openPopover();

    expect(screen.getAllByRole('button', { name: 'Compact now' })).toHaveLength(1);
  });

  it('shows nothing when no handler is wired', () => {
    render(<SessionCard totalTokens={12_000} contextUsage={USAGE} />);
    openPopover();

    expect(screen.queryByRole('button', { name: 'Compact now' })).toBeNull();
  });
});

describe('SessionCard — category breakdown', () => {
  it('draws the breakdown as a bar, not a pie', () => {
    render(<SessionCard totalTokens={120_000} contextUsage={WITH_CATEGORIES} />);
    openPopover();

    // Queried off document, not the render container: the popover portals its
    // content to body. The pie was 18rem of popover height for information the
    // legend below it already carried.
    expect(document.querySelector('.recharts-wrapper')).toBeNull();
    expect(document.querySelectorAll('[data-context-band]').length).toBeGreaterThan(0);
  });

  it('sizes each band by its share of the window', () => {
    render(<SessionCard totalTokens={120_000} contextUsage={WITH_CATEGORIES} />);
    openPopover();

    const bands = document.querySelectorAll<HTMLElement>('[data-context-band]');
    // Largest first, as the legend has always ordered them: Messages is 60k of
    // a 200k window.
    expect(bands[0].getAttribute('data-context-band')).toBe('Messages');
    expect(bands[0].style.width).toBe('30%');
    expect(bands[1].style.width).toBe('20%');
    // Trailing free space is a band too, so the bar always spans the window.
    expect(bands[bands.length - 1].getAttribute('data-context-band')).toBe('Free');
    expect(bands[bands.length - 1].style.width).toBe('40%');
  });

  it('keeps the legend, which is where the numbers are readable', () => {
    render(<SessionCard totalTokens={120_000} contextUsage={WITH_CATEGORIES} />);
    openPopover();

    expect(screen.getByText('System prompt')).toBeTruthy();
    expect(screen.getByText('Tools')).toBeTruthy();
  });
});
