// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { HiddenEventsGroup } from '@/components/HiddenEventsGroup';
import { MessageRenderingPreviewProvider } from '@/contexts/MessageRenderingContext';
import { createDefaultConfig, type HiddenEventsStyle } from '@/lib/messageRenderingConfig';
import { DARK_TEXT } from '@/lib/accentStyle';
import type { JsonlNode } from '@/types/jsonl';

// The rows' own rendering is StreamMessage's business; this file is about the
// card around them.
vi.mock('@/components/StreamMessage', () => ({
  StreamMessage: () => <div data-testid="hidden-row" />,
}));

afterEach(() => { cleanup(); });

const hidden = [
  { kind: 'system', subtype: 'thinking_tokens', sessionId: 's', receivedAt: '', raw: { type: 'system', subtype: 'thinking_tokens' } },
] as unknown as JsonlNode[];

function renderBar(patch: Partial<HiddenEventsStyle>) {
  const hiddenEvents = { background: null, border: null, headerText: null, detailText: null, ...patch };
  const config = createDefaultConfig();
  config.hiddenEvents = hiddenEvents;
  render(
    <MessageRenderingPreviewProvider config={config}>
      <HiddenEventsGroup messages={hidden} streamMessages={hidden} tabId="t1" />
    </MessageRenderingPreviewProvider>,
  );
  return screen.getByRole('button', { name: /hidden event/i });
}

const cardOf = (bar: HTMLElement) => bar.closest<HTMLElement>('[data-hidden-events-card]');

describe('HiddenEventsGroup — card', () => {
  it('renders the bar as the header of a card', () => {
    const bar = renderBar({});
    expect(cardOf(bar)).not.toBeNull();
  });

  it('expands the rows into the body of the same card, with no side rail', () => {
    const bar = renderBar({});
    fireEvent.click(bar);
    const row = screen.getByTestId('hidden-row');
    expect(cardOf(bar)).toContainElement(row);
    const body = row.closest<HTMLElement>('[data-hidden-events-body]');
    expect(body).not.toBeNull();
    expect(body!.className).not.toMatch(/border-l/);
    expect(body!.style.borderLeftColor).toBe('');
  });
});

describe('HiddenEventsGroup — configurable colours', () => {
  it('paints the background on the header and the border around the whole card', () => {
    const bar = renderBar({ background: '#1e293b', border: '#60a5fa' });
    expect(bar).toHaveStyle({ backgroundColor: '#1e293b' });
    expect(cardOf(bar)).toHaveStyle({ borderColor: '#60a5fa' });
  });

  it('carries no inline colour when none is configured', () => {
    const bar = renderBar({});
    expect(bar.style.backgroundColor).toBe('');
    expect(cardOf(bar)!.style.borderColor).toBe('');
    expect(screen.getByText(/1 Hidden Event:/).style.color).toBe('');
  });

  it('keeps text readable on a light background', () => {
    renderBar({ background: '#fde68a' });
    expect(screen.getByText(/1 Hidden Event:/)).toHaveStyle({ color: DARK_TEXT });
  });

  it('uses configured header and detail text colours', () => {
    renderBar({ headerText: '#ff0000', detailText: '#00ff00' });
    expect(screen.getByText(/1 Hidden Event:/)).toHaveStyle({ color: '#ff0000' });
    expect(screen.getByText(/1 Hidden Event:/).nextElementSibling).toHaveStyle({ color: '#00ff00' });
  });
});
