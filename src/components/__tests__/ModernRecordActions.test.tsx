// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';
import type { ModernItem } from '@/lib/modernGrouping';

vi.mock('@/hooks/useLayoutMode', () => ({ useLayoutMode: () => ({ touch: false }) }));
vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));

import { ModernTranscriptItem, type ModernRowContext } from '@/components/transcript-modern/ModernTranscriptItem';

afterEach(() => { cleanup(); });

const ctx = { tabId: 't' } as ModernRowContext;

const statusNode = {
  kind: 'system',
  subtype: 'status',
  receivedAt: '2026-11-23T15:00:00.000Z',
  raw: { type: 'system', subtype: 'status', status: 'compacting', uuid: 'u-status' },
} as unknown as JsonlNode;

const node = (marker: string) => ({ kind: 'system', raw: { type: 'system', subtype: marker } }) as unknown as JsonlNode;

const items: [string, ModernItem][] = [
  ['line without a body', { kind: 'line', key: 'l', node: statusNode, line: { icon: 'info', title: 'Status', tone: 'warn' } } as unknown as ModernItem],
  ['line with a folded body', { kind: 'line', key: 'l2', node: node('folded'), line: { icon: 'info', title: 'Thing', body: 'x\ny', fold: true } } as unknown as ModernItem],
  ['notice', { kind: 'notice', key: 'n', node: node('notice'), tone: 'info', text: 'Heads up' }],
  ['compaction', { kind: 'compaction', key: 'c', node: node('compact_boundary'), detail: 'manual · 777k → 27k tokens' }],
  ['instructions', { kind: 'instructions', key: 'i', node: node('instructions'), files: [{ path: '/repo/CLAUDE.md', scope: 'project' }] }],
  ['question', { kind: 'question', key: 'q', node: node('question'), input: { questions: [{ question: 'Which?', options: [] }] } }],
  ['plan', { kind: 'plan', key: 'p', node: node('plan'), markdown: '# Plan\n- one' }],
];

describe('Modern record items: hover Copy and Raw JSON', () => {
  for (const [name, item] of items) {
    it(`gives a ${name} a Copy button and a Raw JSON viewer`, () => {
      const { container } = render(<ModernTranscriptItem item={item} live={false} ctx={ctx} />);
      const row = container.querySelector('[data-message-actions]') as HTMLElement;
      expect(row).not.toBeNull();
      expect(row.querySelector('button[aria-label="Copy"]')).not.toBeNull();
      expect(row.querySelector('button[aria-label="View raw JSON"]')).not.toBeNull();
    });
  }

  it("opens the record's own JSON, even for a line that has no body", () => {
    const { container } = render(<ModernTranscriptItem item={items[0][1]} live={false} ctx={ctx} />);
    const view = container.querySelector('[data-message-actions] button[aria-label="View raw JSON"]') as HTMLElement;
    fireEvent.click(view);
    const body = screen.getByTestId('raw-json-body');
    expect(body.textContent).toContain('"subtype": "status"');
    expect(body.textContent).toContain('"status": "compacting"');
  });

  it('leads the row with the time, as an answer does', () => {
    const { container } = render(<ModernTranscriptItem item={items[0][1]} live={false} ctx={ctx} />);
    expect(container.querySelector('[data-message-actions] [data-message-stamp]')).not.toBeNull();
  });

  it('puts the actions under the record, as an answer does, not beside it', () => {
    for (const [name, item] of items) {
      const { container } = render(<ModernTranscriptItem item={item} live={false} ctx={ctx} />);
      const row = container.querySelector('[data-record-row]') as HTMLElement;
      expect(row, name).toHaveClass('flex-col');
      expect(row.lastElementChild, name).toHaveAttribute('data-message-actions');
      cleanup();
    }
  });
});

describe('Modern rows: hover highlight', () => {
  const textNode = { kind: 'assistant', receivedAt: '2026-11-23T15:00:00.000Z', raw: { type: 'assistant' } } as unknown as JsonlNode;
  const promptNode = { kind: 'user', receivedAt: '2026-11-23T15:00:00.000Z', raw: { type: 'user' } } as unknown as JsonlNode;
  const rows: [string, ModernItem][] = [
    ['prompt', { kind: 'prompt', key: 'p', node: promptNode, text: 'Hi' }],
    ['answer', { kind: 'text', key: 'a', node: textNode, text: 'Hello' }],
    ['recap', { kind: 'recap', key: 'r', node: textNode, text: 'Recap' }],
    ...items,
  ];
  for (const [name, item] of rows) {
    it(`marks the ${name} row so hovering it highlights the whole message`, () => {
      const { container } = render(<ModernTranscriptItem item={item} live={false} ctx={ctx} />);
      const actions = container.querySelector('[data-message-actions]') as HTMLElement;
      expect(actions.closest('.modern-hover-row'), name).not.toBeNull();
    });
  }
});
