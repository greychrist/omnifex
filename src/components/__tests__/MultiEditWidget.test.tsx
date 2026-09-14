// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MultiEditWidget } from '@/components/claude/tools/MultiEditWidget';

// DiffViewer reaches for the syntax theme via useTheme(), which needs a
// ThemeProvider it has no reason to require in a unit test.
vi.mock('@/hooks', () => ({ useTheme: () => ({ theme: 'gray' }) }));

afterEach(() => { cleanup(); });

const edits = [
  { old_string: "const a = 1;", new_string: "const a = 2;" },
  { old_string: "return a;", new_string: "return a + 1;" },
];

describe('MultiEditWidget', () => {
  it('renders its diffs through the shared viewer, not a second copy of it', () => {
    // The inline copy it used to carry drifted from DiffViewer the moment one
    // of them was restyled — which is how the two surfaces ended up looking
    // different in the first place.
    const { container } = render(<MultiEditWidget file_path="/r/a.ts" edits={edits} />);
    fireEvent.click(screen.getByText('2 edits'));
    expect(container.querySelectorAll('[data-diff-line]').length).toBeGreaterThan(0);
    expect(container.querySelector('.bg-green-500\\/8')).toBeTruthy();
  });

  it('keeps the edits collapsed until asked', () => {
    const { container } = render(<MultiEditWidget file_path="/r/a.ts" edits={edits} />);
    expect(container.querySelector('[data-diff-line]')).toBeNull();
  });
});
