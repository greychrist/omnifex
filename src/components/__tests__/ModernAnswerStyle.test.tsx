// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';
import type { ModernItem } from '@/lib/modernGrouping';
import type { TurnFooter } from '@/lib/modernTurnFooter';

vi.mock('@/hooks/useLayoutMode', () => ({ useLayoutMode: () => ({ touch: false }) }));
vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));

import { ModernTranscriptItem, type ModernRowContext } from '@/components/transcript-modern/ModernTranscriptItem';
import { MessageRenderingPreviewProvider } from '@/contexts/MessageRenderingContext';
import { createDefaultConfig } from '@/lib/messageRenderingConfig';

afterEach(() => { cleanup(); });

const ctx = { lookupsFor: () => ({}), tabId: 't' } as unknown as ModernRowContext;
const node = { kind: 'assistant', raw: { type: 'assistant', message: { content: [] } } } as unknown as JsonlNode;
const item = { kind: 'text', key: 't', node, text: 'All done.' } as ModernItem;
const footer: TurnFooter = { ms: 1000, steps: 2, usd: 0.12 };

function renderWith(answerStyle: 'card' | 'line') {
  const config = createDefaultConfig();
  config.modern = { ...config.modern, answerStyle };
  return render(
    <MessageRenderingPreviewProvider config={config}>
      <ModernTranscriptItem item={item} live={false} ctx={ctx} footer={footer} />
    </MessageRenderingPreviewProvider>,
  );
}

describe('Modern answer style', () => {
  it('draws the answer in the card by default', () => {
    const { container } = renderWith('card');
    expect(screen.getByText('All done.').closest('.modern-final-card')).not.toBeNull();
    expect(container.querySelector('.modern-final-line')).toBeNull();
  });

  it('draws only a bar on the left in line style, keeping the chip and the Done line', () => {
    const { container } = renderWith('line');
    const line = screen.getByText('All done.').closest('.modern-final-line');
    expect(line).not.toBeNull();
    expect(container.querySelector('.modern-final-card')).toBeNull();
    expect(line).not.toHaveClass('modern-card-shadow');
    expect(container.querySelector('[data-final-chip]')).not.toBeNull();
    expect(container.querySelector('[data-turn-footer]')).not.toBeNull();
  });

  // The same 16px off the rule as every other ruled text in Modern: a
  // recap, an opened compaction or step (TraceCollapsibleContent's pl-4).
  it('sets the answer 16px off the bar, as the other ruled text is', () => {
    renderWith('line');
    const line = screen.getByText('All done.').closest('.modern-final-line');
    expect(line).toHaveClass('pl-4');
    expect(line).not.toHaveClass('pl-3');
  });
});
