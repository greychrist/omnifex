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

afterEach(() => { cleanup(); });

const ctx = { lookupsFor: () => ({}), tabId: 't' } as unknown as ModernRowContext;
const node = { kind: 'system', subtype: 'away_summary', raw: { type: 'system', subtype: 'away_summary' } } as unknown as JsonlNode;

describe('Modern recap', () => {
  it('draws a Recap line over the prose, open, not the Compact card', () => {
    const item = { kind: 'recap', key: 'r', node, text: 'We fixed the card; tests pass.' } as ModernItem;
    const { container } = render(<ModernTranscriptItem item={item} live={false} ctx={ctx} />);
    expect(screen.getByText('Recap')).toBeInTheDocument();
    expect(screen.getByText('We fixed the card; tests pass.')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="trace"]')).not.toBeNull();
    // No Compact chrome: neither the card frame nor its italic prose.
    expect(container.querySelector('.italic')).toBeNull();
  });

  // Spaced exactly as an answer is: the same Message column, with the same
  // hover row under it (which is where an answer's room below comes from).
  it('sits in the answer\'s Message column with its hover row, so the room below matches', () => {
    const item = { kind: 'recap', key: 'r', node, text: 'Done.' } as ModernItem;
    const { container } = render(<ModernTranscriptItem item={item} live={false} ctx={ctx} />);
    const column = container.querySelector('[data-recap]')?.parentElement;
    expect(column).toHaveClass('group', 'flex-col', 'gap-1.5');
    const actions = column?.lastElementChild;
    expect(actions).toHaveClass('h-6');
    expect(actions?.querySelector('button')).not.toBeNull();
    // No spacing of its own on top of that.
    expect(container.querySelector('[data-recap-body]')).not.toHaveClass('mb-3');
  });

  // Its date and time lead the hover row, as an answer's do; the title is
  // "Recap" alone.
  it('stamps the date and time in its hover row, not beside its title', () => {
    const d = new Date(2026, 2, 4, 15, 4, 5);
    const timed = { ...node, receivedAt: d.toISOString() } as unknown as JsonlNode;
    const item = { kind: 'recap', key: 'r', node: timed, text: 'Done.' } as ModernItem;
    const { container } = render(<ModernTranscriptItem item={item} live={false} ctx={ctx} />);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    const row = container.querySelector('[data-message-actions]') as HTMLElement;
    expect(row.firstElementChild).toHaveAttribute('data-message-stamp');
    expect(row.firstElementChild).toHaveTextContent(`3-4-2026 ${time}`);
    const line = container.querySelector('[data-recap] [data-slot="trace-line"]') as HTMLElement;
    expect(line.textContent).toBe('Recap');
  });
});
