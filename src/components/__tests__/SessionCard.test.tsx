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

describe('SessionCard — context gauge', () => {
  it('sizes the gauge against the window it is handed (1M)', () => {
    render(<SessionCard totalTokens={181_886} contextLimit={1_000_000} sessionStatus="active" />);
    expect(screen.getByText('18%')).toBeTruthy();
    expect(screen.queryByText('91%')).toBeNull();
  });

  it('sizes the gauge against the window it is handed (200k)', () => {
    render(<SessionCard totalTokens={181_886} contextLimit={200_000} sessionStatus="active" />);
    expect(screen.getByText('91%')).toBeTruthy();
  });

  it('renders the active-controls summary above the context gauge', () => {
    render(
      <SessionCard
        totalTokens={12_000}
        contextLimit={200_000}
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
        contextLimit={200_000}
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
        contextLimit={200_000}
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
        contextLimit={200_000}
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
    render(<SessionCard totalTokens={12_000} contextLimit={200_000} contextUsage={USAGE} onCompact={() => {}} />);
    openPopover();

    expect(screen.getByRole('button', { name: 'Compact now' })).toBeTruthy();
  });

  it('runs the handler when pressed', () => {
    let ran = 0;
    render(<SessionCard totalTokens={12_000} contextLimit={200_000} contextUsage={USAGE} onCompact={() => { ran += 1; }} />);
    openPopover();

    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }));
    expect(ran).toBe(1);
  });

  it('goes inert while a turn is in flight, rather than vanishing', () => {
    render(
      <SessionCard totalTokens={12_000} contextLimit={200_000} contextUsage={USAGE} onCompact={() => {}} compactDisabled />,
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
        contextLimit={200_000} contextUsage={USAGE}
        onCompact={() => {}}
        pendingAction={pending}
      />,
    );
    openPopover();

    expect(screen.getAllByRole('button', { name: 'Compact now' })).toHaveLength(1);
  });

  it('shows nothing when no handler is wired', () => {
    render(<SessionCard totalTokens={12_000} contextLimit={200_000} contextUsage={USAGE} />);
    openPopover();

    expect(screen.queryByRole('button', { name: 'Compact now' })).toBeNull();
  });
});

describe('SessionCard — category breakdown', () => {
  // The breakdown lives behind the `Details` disclosure, which starts open.
  // Its default state is asserted separately, in "SessionCard — context
  // popover layout".
  const openBreakdown = () => {
    openPopover();
  };

  afterEach(() => {
    window.localStorage.removeItem('greychrist.sessionCard.detailsExpanded');
    window.localStorage.removeItem('greychrist.sessionCard.eventsExpanded');
  });

  it('draws the breakdown as a bar, not a pie', () => {
    render(<SessionCard totalTokens={120_000} contextLimit={200_000} contextUsage={WITH_CATEGORIES} />);
    openBreakdown();

    // Queried off document, not the render container: the popover portals its
    // content to body. The pie was 18rem of popover height for information the
    // legend below it already carried.
    expect(document.querySelector('.recharts-wrapper')).toBeNull();
    expect(document.querySelectorAll('[data-context-band]').length).toBeGreaterThan(0);
  });

  it('sizes each band by its share of the window', () => {
    render(<SessionCard totalTokens={120_000} contextLimit={200_000} contextUsage={WITH_CATEGORIES} />);
    openBreakdown();

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
    render(<SessionCard totalTokens={120_000} contextLimit={200_000} contextUsage={WITH_CATEGORIES} />);
    openBreakdown();

    expect(screen.getByText('System prompt')).toBeTruthy();
    expect(screen.getByText('Tools')).toBeTruthy();
  });
});

describe('SessionCard — unread session events', () => {
  const EVENTS = [
    {
      id: 'e1', tabId: 't', kind: 'event' as const, anchor: 'session' as const,
      priority: 'normal' as const, key: 'context.jump', title: 'Context jump',
      detail: 'CONTEXT-JUMP-ROW', at: Date.now(), read: false,
    },
  ];

  it('marks signals read when the popover closes, not the moment it opens', () => {
    // Opening used to mark everything read immediately, which dropped the
    // unread tint before the reader had scrolled to the list it applies to.
    // The evidence destroyed itself on the way to being read.
    let readCalls = 0;
    render(
      <SessionCard
        totalTokens={12_000}
        contextLimit={200_000} contextUsage={USAGE}
        recentEvents={EVENTS}
        onSignalsRead={() => { readCalls += 1; }}
      />,
    );

    fireEvent.click(screen.getByText('12.0k'));
    fireEvent.click(screen.getByRole('button', { name: /recent events/i }));
    expect(readCalls).toBe(0);
    expect(screen.getByText('CONTEXT-JUMP-ROW')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(readCalls).toBe(1);
  });

  // The unread count used to ride on the token meter as a small number. It
  // said nothing actionable — the events are one click away and the meter it
  // sat on is about tokens, not events — so it is gone, along with the
  // aria-label gymnastics needed to explain what it was counting.
  it('carries no unread count on the trigger', () => {
    render(
      <SessionCard totalTokens={12_000} contextLimit={200_000} contextUsage={USAGE} recentEvents={EVENTS} />,
    );
    const trigger = screen.getByLabelText('Context usage');
    expect(trigger.getAttribute('aria-label')).toBe('Context usage');
    expect(trigger.textContent).not.toMatch(/\d+\s*new/);
  });
});

const DETAILS_KEY = 'greychrist.sessionCard.detailsExpanded';
const EVENTS_KEY = 'greychrist.sessionCard.eventsExpanded';

const CATEGORY_USAGE: SessionContextUsage = {
  totalTokens: 50_104,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  percentage: 5,
  model: 'opus',
  categories: [
    { name: 'Free space', tokens: 916_896, color: '#888' },
    { name: 'Messages', tokens: 19_339, color: '#3b82f6' },
    { name: 'Memory files', tokens: 16_272, color: '#f59e0b' },
  ],
};

function renderWithCategories(extra: Record<string, unknown> = {}) {
  return render(
    <SessionCard
      totalTokens={50_104}
      contextLimit={1_000_000}
      contextUsage={CATEGORY_USAGE}
      sessionStatus="active"
      {...extra}
    />,
  );
}

function openCategoryPopover() {
  fireEvent.click(screen.getByText('50.1k'));
}

describe('SessionCard — context popover layout', () => {
  afterEach(() => {
    window.localStorage.removeItem(DETAILS_KEY);
    window.localStorage.removeItem(EVENTS_KEY);
  });

  it('shows the category breakdown by default', () => {
    renderWithCategories();
    openCategoryPopover();
    expect(screen.getByText('Messages')).toBeTruthy();
    expect(screen.getByText('Memory files')).toBeTruthy();
  });

  it('hides the breakdown when Details is closed, and remembers it', () => {
    renderWithCategories();
    openCategoryPopover();
    fireEvent.click(screen.getByRole('button', { name: /details/i }));
    expect(screen.queryByText('Messages')).toBeNull();
    expect(window.localStorage.getItem(DETAILS_KEY)).toBe('0');
  });

  it('starts collapsed when the stored preference says so', () => {
    window.localStorage.setItem(DETAILS_KEY, '0');
    renderWithCategories();
    openCategoryPopover();
    expect(screen.queryByText('Messages')).toBeNull();
  });

  it('collapses Recent events by default, and remembers opening it', () => {
    renderWithCategories();
    openCategoryPopover();
    const toggle = screen.getByRole('button', { name: /recent events/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Nothing to report yet.')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText('Nothing to report yet.')).toBeTruthy();
    expect(window.localStorage.getItem(EVENTS_KEY)).toBe('1');
  });

  it('does not write a preference just by opening the popover', () => {
    renderWithCategories();
    openCategoryPopover();
    expect(window.localStorage.getItem(DETAILS_KEY)).toBeNull();
    expect(window.localStorage.getItem(EVENTS_KEY)).toBeNull();
  });

  it('orders the popover: Details, Recent events, session id', () => {
    renderWithCategories({
      sessionId: 'fe10d371-620b-4e16-b412-62cd401ca3aa',
    });
    openCategoryPopover();
    const ids = ['details-disclosure', 'recent-events', 'session-id'];
    const nodes = ids.map((id) => screen.getByTestId(id));
    for (let i = 1; i < nodes.length; i++) {
      expect(
        nodes[i - 1].compareDocumentPosition(nodes[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('keeps Compact now above the Details disclosure', () => {
    renderWithCategories({ onCompact: () => {} });
    openCategoryPopover();
    const compact = screen.getByText('Compact now');
    const details = screen.getByTestId('details-disclosure');
    expect(
      compact.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
