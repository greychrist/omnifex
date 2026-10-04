// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MessageFrameCollapsible } from '@/components/StreamMessage/MessageFrameCollapsible';
import { CardActionBar } from '@/components/CardActionBar';
import { MessageRenderingPreviewProvider } from '@/contexts/MessageRenderingContext';
import { createDefaultConfig } from '@/lib/messageRenderingConfig';

// jsdom has no clipboard; the Copy click below would otherwise throw.
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});
afterEach(() => { cleanup(); });

function renderCard() {
  render(
    <MessageRenderingPreviewProvider config={createDefaultConfig()}>
      <MessageFrameCollapsible kindId="system.unknown" headerLabel="Context" actionBar={<CardActionBar text="hello" />}>
        <div data-testid="body">body</div>
      </MessageFrameCollapsible>
    </MessageRenderingPreviewProvider>,
  );
  return {
    bar: screen.getByRole('toolbar'),
    toggle: screen.getByRole('button', { name: /context/i }),
    chevron: document.querySelector<HTMLElement>('[data-collapsible-chevron]'),
  };
}

describe('MessageFrameCollapsible — action bar', () => {
  it('seats the bar in the header row, centred by flex, not pinned to the corner', () => {
    const { bar, toggle } = renderCard();
    expect(bar.className).not.toMatch(/\babsolute\b/);
    expect(bar.parentElement).toBe(toggle.parentElement);
    expect(bar.parentElement!.className).toMatch(/\bitems-center\b/);
  });

  it('ends the header with the hidden-events up/down chevron, after the bar', () => {
    const { bar, chevron } = renderCard();
    expect(chevron).not.toBeNull();
    expect(chevron!.querySelector('svg.lucide-chevrons-up-down')).not.toBeNull();
    expect(chevron!.parentElement).toBe(bar.parentElement);
    expect(bar.compareDocumentPosition(chevron!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chevron!.parentElement!.lastElementChild).toBe(chevron);
  });

  it('toggles from the chevron too', () => {
    const { chevron } = renderCard();
    fireEvent.click(chevron!);
    expect(screen.getByTestId('body')).toBeInTheDocument();
    fireEvent.click(chevron!);
    expect(screen.queryByTestId('body')).toBeNull();
  });

  it('keeps the bar outside the toggle, so its buttons do not expand the card', () => {
    const { bar, toggle } = renderCard();
    expect(toggle).not.toContainElement(bar);
    fireEvent.click(screen.getByRole('button', { name: /copy content/i }));
    expect(screen.queryByTestId('body')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByTestId('body')).toBeInTheDocument();
  });
});
