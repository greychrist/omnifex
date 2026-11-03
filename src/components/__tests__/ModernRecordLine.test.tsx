// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';
import type { ModernItem } from '@/lib/modernGrouping';
import type { ModernLine } from '@/lib/modernLines';

vi.mock('@/hooks/useLayoutMode', () => ({ useLayoutMode: () => ({ touch: false }) }));
vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));

import { ModernTranscriptItem, type ModernRowContext } from '@/components/transcript-modern/ModernTranscriptItem';

afterEach(() => { cleanup(); });

const ctx = { lookupsFor: () => ({}), tabId: 't' } as unknown as ModernRowContext;
const node = { kind: 'permission-mode', raw: { type: 'permission-mode' } } as unknown as JsonlNode;
const draw = (line: ModernLine) =>
  render(<ModernTranscriptItem item={{ kind: 'line', key: 'l', node, line } as ModernItem} live={false} ctx={ctx} />);

describe('Modern record line', () => {
  it('is a Trace line, title and detail, not a Compact card', () => {
    const { container } = draw({ icon: 'ShieldCheck', title: 'Permission mode', detail: 'Accept Edits' });
    expect(container.querySelector('[data-slot="trace"]')).not.toBeNull();
    expect(screen.getByText('Permission mode')).toBeInTheDocument();
    expect(screen.getByText('Accept Edits')).toBeInTheDocument();
    expect(container.querySelector('[data-frame-variant]')).toBeNull();
  });

  it('shows an open body under the rule, in mono when asked', () => {
    draw({ icon: 'Terminal', title: '/cost', body: 'Total cost: $1.20', mono: true, fold: false });
    expect(screen.getByText('Total cost: $1.20').closest('.font-mono')).not.toBeNull();
  });

  it('folds a long body until the line is opened', () => {
    draw({ icon: 'Info', title: 'Informational', body: 'first\nsecond', fold: true });
    expect(screen.queryByText(/first/)).toBeNull();
    fireEvent.click(screen.getByText('Informational'));
    expect(screen.getByText(/first/)).toBeInTheDocument();
  });

  it('draws a warning line in the context-warning amber', () => {
    const { container } = draw({ icon: 'HelpCircle', title: 'Unrecognized record: brand-new', tone: 'warn' });
    const head = container.querySelector('[data-slot="trace-line"][data-status="warn"]');
    expect(head).not.toBeNull();
    expect(head?.className).toContain('data-[status=warn]:text-amber-500');
  });

  it('draws an error line in the error colour', () => {
    const { container } = draw({ icon: 'AlertTriangle', title: 'API error', detail: 'Overloaded', tone: 'error' });
    expect(container.querySelector('[data-slot="trace-line"][data-status="error"]')).not.toBeNull();
  });
});
