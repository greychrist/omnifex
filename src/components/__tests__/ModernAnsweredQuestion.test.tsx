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
  // Drawn as Modern's other record lines are (RecordLine, RecapLine): a Trace
  // line over an open body under the left rule, not the classic card. The
  // icon keeps the question kind's purple accent.
  it('is a Trace line, not the classic answered card', () => {
    const { container } = render(<ModernTranscriptItem item={item} live={false} ctx={ctx} />);
    expect(screen.queryByTestId('answered-ask-user-question-card')).toBeNull();
    expect(container.querySelector('[data-slot="trace"][data-question-line]')).not.toBeNull();
    expect(screen.getByText('2 questions answered')).toBeInTheDocument();
  });

  it('colours the icon in the question kind\'s purple accent', () => {
    const { container } = render(<ModernTranscriptItem item={item} live={false} ctx={ctx} />);
    const icon = container.querySelector('[data-slot="trace-icon"]') as HTMLElement;
    expect(icon.style.color).toBe('rgb(99, 102, 241)');
  });

  // The title and the rule beside the answers wear the same purple. Inline,
  // because the unlayered `* { border-color }` reset beats the utilities.
  it('colours the title and the left rule in that purple too', () => {
    const { container } = render(<ModernTranscriptItem item={item} live={false} ctx={ctx} />);
    expect((screen.getByText('2 questions answered') as HTMLElement).style.color).toBe('rgb(99, 102, 241)');
    const rule = container.querySelector('[data-question-body]') as HTMLElement;
    expect(rule.style.borderLeftColor).toBe('rgb(99, 102, 241)');
    // A hairline: a solid purple at 1px read heavier than the grey 1px rules.
    expect(rule.style.borderLeftWidth).toBe('0.5px');
    expect(rule.style.borderLeftStyle).toBe('solid');
  });

  // Each question is in the muted text colour with its text underlined; the
  // answer under it is in the foreground colour.
  it('underlines each question in the muted colour, the answer in the foreground', () => {
    render(<ModernTranscriptItem item={item} live={false} ctx={ctx} />);
    const q = screen.getByText('Add the review task?');
    expect(q).toHaveClass('underline');
    expect(q.parentElement).toHaveClass('text-muted-foreground');
    expect((q.parentElement as HTMLElement).style.color).toBe('');
    expect(screen.getByText('Your task')).not.toHaveClass('underline');
    expect(screen.getByText('Yes, add it (Recommended)')).toHaveClass('text-foreground');
  });

  it('lists each question with its answer, open under the rule', () => {
    render(<ModernTranscriptItem item={item} live={false} ctx={ctx} />);
    expect(screen.getByText('Add the review task?')).toBeInTheDocument();
    expect(screen.getByText('Create the tickets now?')).toBeInTheDocument();
    expect(screen.getByText('Show me first')).toBeInTheDocument();
    expect(screen.getByText('Your task')).toBeInTheDocument();
  });

  it('says "Question answered" for one', () => {
    const one = { ...item, input: { questions: [input.questions[1]] } } as ModernItem;
    render(<ModernTranscriptItem item={one} live={false} ctx={ctx} />);
    expect(screen.getByText('Question answered')).toBeInTheDocument();
  });

  it('shows an answer containing a comma as picked, not as a typed answer', () => {
    render(<ModernTranscriptItem item={item} live={false} ctx={ctx} />);
    expect(screen.getByText('Yes, add it (Recommended)')).toBeInTheDocument();
    expect(screen.queryByText(/^Other:/)).toBeNull();
  });

  it('marks a typed Other answer', () => {
    const typed = {
      ...item,
      input: { questions: [input.questions[1]] },
      resultNode: {
        kind: 'user',
        raw: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1',
          content: 'Your questions have been answered: "Create the tickets now?"="Only RTR-15" notes: User selected Other: "Only RTR-15". You can now continue.' }] } },
      },
    } as unknown as ModernItem;
    render(<ModernTranscriptItem item={typed} live={false} ctx={ctx} />);
    expect(screen.getByText('Other: Only RTR-15')).toBeInTheDocument();
  });
});
