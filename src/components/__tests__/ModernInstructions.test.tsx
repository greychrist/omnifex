// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';
import type { ModernItem } from '@/lib/modernGrouping';

vi.mock('@/hooks/useLayoutMode', () => ({ useLayoutMode: () => ({ touch: false }) }));
vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));

import { ModernTranscriptItem, type ModernRowContext } from '@/components/transcript-modern/ModernTranscriptItem';

afterEach(() => { cleanup(); });

const ctx = { lookupsFor: () => ({}), tabId: 't' } as unknown as ModernRowContext;
const node = { kind: 'attachment', raw: { type: 'attachment' } } as unknown as JsonlNode;

describe('Modern instructions line', () => {
  it('is one folded Trace line naming the count, opening onto the paths', () => {
    const item = { kind: 'instructions', key: 'i', node, files: [
      { path: '/a/CLAUDE.md', scope: 'User' },
      { path: '/b/CLAUDE.md', scope: 'Project' },
    ] } as ModernItem;
    const { container } = render(<ModernTranscriptItem item={item} live={false} ctx={ctx} />);
    expect(screen.getByText('Loaded instructions')).toBeInTheDocument();
    expect(screen.getByText('2 files')).toBeInTheDocument();
    expect(screen.queryByText('/a/CLAUDE.md')).toBeNull();
    expect(container.querySelector('[data-slot="trace"]')).not.toBeNull();
    fireEvent.click(screen.getByText('Loaded instructions'));
    expect(screen.getByText('/a/CLAUDE.md')).toBeInTheDocument();
    expect(screen.getByText('Project')).toBeInTheDocument();
  });

  it('says "1 file" for one', () => {
    const item = { kind: 'instructions', key: 'i', node, files: [{ path: '/a/CLAUDE.md', scope: null }] } as ModernItem;
    render(<ModernTranscriptItem item={item} live={false} ctx={ctx} />);
    expect(screen.getByText('1 file')).toBeInTheDocument();
  });
});
