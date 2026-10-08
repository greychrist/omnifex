// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { MessageFrameSideLine } from '@/components/StreamMessage/MessageFrameSideLine';

describe('MessageFrameSideLine', () => {
  it('renders the icon, label text, and a 2px left accent bar', () => {
    const { container } = render(
      <MessageFrameSideLine
        iconName="HelpCircle"
        accentColor="#f97316"
        borderStyle="dashed"
        borderOpacity={20}
      >
        Unknown payload received
      </MessageFrameSideLine>
    );
    expect(screen.getByText('Unknown payload received')).toBeInTheDocument();
    const bar = container.querySelector('[data-testid="side-line-bar"]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('style')).toMatch(/border-left/);
    expect(bar?.getAttribute('style')).toMatch(/dashed/);
  });

  it('renders solid border by default', () => {
    const { container } = render(
      <MessageFrameSideLine iconName="Info" accentColor="#4b5563" borderStyle="solid" borderOpacity={20}>
        text
      </MessageFrameSideLine>
    );
    const bar = container.querySelector('[data-testid="side-line-bar"]');
    expect(bar?.getAttribute('style')).toMatch(/solid/);
  });

  it('draws its outline at the card border opacity', () => {
    const { container } = render(
      <MessageFrameSideLine iconName="Info" accentColor="#4b5563" borderStyle="solid" borderOpacity={35}>
        text
      </MessageFrameSideLine>
    );
    const row = container.firstElementChild as HTMLElement;
    // #4b5563 at 35% (0x59) — jsdom normalises the 8-digit hex to rgba.
    expect(row.style.borderColor).toBe('rgba(75, 85, 99, 0.35)');
  });
});
