// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { HiddenEventsGroup } from '@/components/HiddenEventsGroup';
import { MessageRenderingPreviewProvider } from '@/contexts/MessageRenderingContext';
import { createDefaultConfig, type HiddenEventsStyle } from '@/lib/messageRenderingConfig';
import { DARK_TEXT } from '@/lib/accentStyle';
import type { JsonlNode } from '@/types/jsonl';

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

describe('HiddenEventsGroup — configurable colours', () => {
  it('paints the configured background and border', () => {
    const bar = renderBar({ background: '#1e293b', border: '#60a5fa' });
    expect(bar).toHaveStyle({ backgroundColor: '#1e293b', borderColor: '#60a5fa' });
  });

  it('carries no inline colour when none is configured', () => {
    const bar = renderBar({});
    expect(bar.style.backgroundColor).toBe('');
    expect(bar.style.borderColor).toBe('');
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
