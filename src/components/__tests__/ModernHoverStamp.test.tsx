// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, cleanup } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';
import type { ModernItem } from '@/lib/modernGrouping';

vi.mock('@/hooks/useLayoutMode', () => ({ useLayoutMode: () => ({ touch: false }) }));
vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));

import { ModernTranscriptItem, type ModernRowContext } from '@/components/transcript-modern/ModernTranscriptItem';

afterEach(() => { cleanup(); });

const ctx = { lookupsFor: () => ({}), tabId: 't', onResend: () => {} } as unknown as ModernRowContext;
const thisYear = new Date().getFullYear();
const at = new Date(thisYear, 2, 4, 15, 4, 5);
const lastYear = new Date(thisYear - 1, 10, 9, 8, 7, 6);

const nodeAt = (d: Date, kind: string) => ({ kind, receivedAt: d.toISOString(), raw: { type: kind, message: { content: [] } } }) as unknown as JsonlNode;
const prompt = (d: Date) => ({ kind: 'prompt', key: 'p', node: nodeAt(d, 'user'), text: 'Hi' }) as ModernItem;
const answer = (d: Date) => ({ kind: 'text', key: 'a', node: nodeAt(d, 'assistant'), text: 'Hello' }) as ModernItem;

const hoverRow = (container: HTMLElement) => container.querySelector('[data-message-actions]') as HTMLElement;
const timeText = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

describe('Modern hover row', () => {
  // The date as well as the time, first in the row, before Copy and the rest.
  for (const [name, make] of [['prompt', prompt], ['answer', answer]] as const) {
    it(`leads the ${name}'s hover row with the date and the time`, () => {
      const { container } = render(<ModernTranscriptItem item={make(at)} live={false} ctx={ctx} />);
      const first = hoverRow(container).firstElementChild as HTMLElement;
      expect(first.tagName).toBe('SPAN');
      expect(first).toHaveAttribute('data-message-stamp');
      // M-D-YYYY, unpadded, then the time.
      expect(first.textContent).toBe(`3-4-${String(thisYear)} ${timeText(at)}`);
    });
  }

  it('leaves a two-digit month and day as they are and always names the year', () => {
    const { container } = render(<ModernTranscriptItem item={answer(lastYear)} live={false} ctx={ctx} />);
    const stamp = hoverRow(container).querySelector('[data-message-stamp]') as HTMLElement;
    expect(stamp.textContent).toBe(`11-9-${String(thisYear - 1)} ${timeText(lastYear)}`);
  });

  it('shows no stamp when the record has no time', () => {
    const bare = { kind: 'text', key: 'a', node: { kind: 'assistant', raw: { type: 'assistant' } }, text: 'x' } as unknown as ModernItem;
    const { container } = render(<ModernTranscriptItem item={bare} live={false} ctx={ctx} />);
    expect(hoverRow(container).querySelector('[data-message-stamp]')).toBeNull();
  });
});
