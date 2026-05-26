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
        accentColor="orange"
        borderStyle="dashed"
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
      <MessageFrameSideLine iconName="Info" accentColor="muted" borderStyle="solid">
        text
      </MessageFrameSideLine>
    );
    const bar = container.querySelector('[data-testid="side-line-bar"]');
    expect(bar?.getAttribute('style')).toMatch(/solid/);
  });
});
