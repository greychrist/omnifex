// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';
import type { ModernItem } from '@/lib/modernGrouping';

vi.mock('@/hooks/useLayoutMode', () => ({ useLayoutMode: () => ({ touch: false }) }));

import { ModernTranscriptItem, type ModernRowContext } from '@/components/transcript-modern/ModernTranscriptItem';

afterEach(() => { cleanup(); });

const ctx = { lookupsFor: () => ({}), tabId: 't' } as unknown as ModernRowContext;

const input = {
  questions: [
    { header: 'Your task', question: 'Add the review task?', options: [{ label: 'Yes, add it (Recommended)' }, { label: 'No' }] },
    { header: 'Create now?', question: 'Create the tickets now?', options: [{ label: 'Show me first' }, { label: 'Create them' }] },
  ],
};
const node = { kind: 'assistant', raw: { type: 'assistant', message: { content: [] } } } as unknown as JsonlNode;
const resultNode = {
  kind: 'user',
  raw: {
    type: 'user',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: 'tu1',
        content: 'Your questions have been answered: "Add the review task?"="Yes, add it (Recommended)", "Create the tickets now?"="Show me first". You can now continue.',
      }],
    },
  },
} as unknown as JsonlNode;

const item = { kind: 'question', key: 'q-1', node, input, resultNode } as ModernItem;

describe('Modern answered question', () => {
  it('is drawn as the classic answered card', () => {
    render(<ModernTranscriptItem item={item} live={false} ctx={ctx} />);
    expect(screen.getByTestId('answered-ask-user-question-card')).toBeInTheDocument();
    expect(screen.getByText('2 questions answered')).toBeInTheDocument();
  });

  it('shows an answer containing a comma as picked, not as a typed answer', () => {
    render(<ModernTranscriptItem item={item} live={false} ctx={ctx} />);
    expect(screen.getByText('Yes, add it (Recommended)')).toBeInTheDocument();
    expect(screen.queryByText('Typed answer')).toBeNull();
  });
});
