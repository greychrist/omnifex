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
const node = { type: 'user', message: { content: [] } } as unknown as JsonlNode;

function prompt(text: string, command?: true): ModernItem {
  return { kind: 'prompt', text, node, ...(command ? { command } : {}) } as ModernItem;
}

describe('Modern prompt bubble', () => {
  it('sets only the slash command name in mono, not its arguments', () => {
    render(<ModernTranscriptItem item={prompt('/compact keep the plan', true)} live={false} ctx={ctx} />);
    expect(screen.getByText('/compact')).toHaveClass('font-mono');
    const args = screen.getByText('keep the plan', { exact: false });
    expect(args).not.toHaveClass('font-mono');
    expect(args.closest('.font-mono')).toBeNull();
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
});
