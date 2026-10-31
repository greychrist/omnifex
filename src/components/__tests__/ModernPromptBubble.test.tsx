// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';
import type { ModernItem } from '@/lib/modernGrouping';

vi.mock('@/hooks/useLayoutMode', () => ({ useLayoutMode: () => ({ touch: false }) }));
vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));

import { ModernTranscriptItem, type ModernRowContext } from '@/components/transcript-modern/ModernTranscriptItem';
import { MessageRenderingPreviewProvider } from '@/contexts/MessageRenderingContext';
import { createDefaultConfig } from '@/lib/messageRenderingConfig';

afterEach(() => { cleanup(); });

const ctx = { lookupsFor: () => ({}), tabId: 't' } as unknown as ModernRowContext;
const node = { type: 'user', message: { content: [] } } as unknown as JsonlNode;

function prompt(text: string): ModernItem {
  return { kind: 'prompt', text, node } as ModernItem;
}

describe('Modern prompt bubble', () => {
  it('draws a slash command in the body font, name and arguments alike', () => {
    render(<ModernTranscriptItem item={prompt('/compact keep the plan')} live={false} ctx={ctx} />);
    expect(screen.getByText('/compact keep the plan').closest('.font-mono')).toBeNull();
  });

  it('draws a bare slash command in the body font', () => {
    render(<ModernTranscriptItem item={prompt('/deploy-to-production')} live={false} ctx={ctx} />);
    expect(screen.getByText('/deploy-to-production').closest('.font-mono')).toBeNull();
  });

  it('draws an ordinary prompt in the body font', () => {
    render(<ModernTranscriptItem item={prompt('hello there')} live={false} ctx={ctx} />);
    expect(screen.getByText('hello there').closest('.font-mono')).toBeNull();
  });

  it('draws the prompt in the tinted, bordered bubble', () => {
    render(<ModernTranscriptItem item={prompt('hello there')} live={false} ctx={ctx} />);
    const bubble = screen.getByText('hello there').closest('.modern-prompt');
    expect(bubble).not.toBeNull();
    expect(bubble).not.toHaveClass('bg-muted');
    // The card corner radius (All cards › Corner radius), not a pill.
    expect((bubble as HTMLElement).style.borderRadius).toBe('12px');
  });

  // Settings › Chats › Modern › Drop shadow: on unless switched off.
  it('wears the drop shadow by default, and not once it is switched off', () => {
    const { unmount } = render(<ModernTranscriptItem item={prompt('hello there')} live={false} ctx={ctx} />);
    expect(screen.getByText('hello there').closest('.modern-prompt')).toHaveClass('modern-card-shadow');
    unmount();
    const config = createDefaultConfig();
    config.modern = { ...config.modern, promptShadow: false };
    render(
      <MessageRenderingPreviewProvider config={config}>
        <ModernTranscriptItem item={prompt('hello there')} live={false} ctx={ctx} />
      </MessageRenderingPreviewProvider>,
    );
    expect(screen.getByText('hello there').closest('.modern-prompt')).not.toHaveClass('modern-card-shadow');
  });

  // Settings › Chats › Modern › Prompt bubble color › Enabled: off, the
  // bubble has no fill or border and the page shows through (`.modern-card-plain`).
  it('drops its fill and border when its color is switched off', () => {
    const config = createDefaultConfig();
    config.modern = { ...config.modern, promptColorEnabled: false };
    render(
      <MessageRenderingPreviewProvider config={config}>
        <ModernTranscriptItem item={prompt('hello there')} live={false} ctx={ctx} />
      </MessageRenderingPreviewProvider>,
    );
    expect(screen.getByText('hello there').closest('.modern-prompt')).toHaveClass('modern-card-plain');
  });

  it('keeps its color by default', () => {
    render(<ModernTranscriptItem item={prompt('hello there')} live={false} ctx={ctx} />);
    expect(screen.getByText('hello there').closest('.modern-prompt')).not.toHaveClass('modern-card-plain');
  });

  // Color off takes the shadow with it: a shadow under an invisible card.
  // The shadow setting is kept, for when the color comes back.
  it('drops its shadow too when its color is switched off', () => {
    const config = createDefaultConfig();
    config.modern = { ...config.modern, promptColorEnabled: false, promptShadow: true };
    render(
      <MessageRenderingPreviewProvider config={config}>
        <ModernTranscriptItem item={prompt('hello there')} live={false} ctx={ctx} />
      </MessageRenderingPreviewProvider>,
    );
    expect(screen.getByText('hello there').closest('.modern-prompt')).not.toHaveClass('modern-card-shadow');
  });

  it('drops the answer card\'s shadow too when its color is switched off', () => {
    const config = createDefaultConfig();
    config.modern = { ...config.modern, answerCardColorEnabled: false, answerCardShadow: true };
    const answer = { kind: 'text', key: 'a', text: 'All done.', node } as ModernItem;
    const { container } = render(
      <MessageRenderingPreviewProvider config={config}>
        <ModernTranscriptItem item={answer} live={false} ctx={ctx} footer={{ ms: 2000, steps: 1, usd: null }} />
      </MessageRenderingPreviewProvider>,
    );
    const card = container.querySelector('.modern-final-card');
    expect(card).toHaveClass('modern-card-plain');
    expect(card).not.toHaveClass('modern-card-shadow');
  });
});
