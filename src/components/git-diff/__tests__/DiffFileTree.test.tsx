// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react';

import { DiffFileTree } from '@/components/git-diff/DiffFileTree';
import type { GitChangedFile } from '@/lib/api';

afterEach(() => { cleanup(); });

const f = (path: string, over: Partial<GitChangedFile> = {}): GitChangedFile => ({
  path,
  status: 'modified',
  staged: false,
  ...over,
});

function renderTree(files: GitChangedFile[], selected: string | null = null) {
  const onSelect = vi.fn();
  render(<DiffFileTree files={files} selectedPath={selected} onSelect={onSelect} />);
  return { onSelect };
}

describe('DiffFileTree', () => {
  describe('rendering', () => {
    it('shows a root-level file by name', () => {
      renderTree([f('README.md')]);
      expect(screen.getByText('README.md')).toBeTruthy();
    });

    it('shows a nested file under its directory', () => {
      renderTree([f('src/a.ts')]);
      expect(screen.getByText('src')).toBeTruthy();
      expect(screen.getByText('a.ts')).toBeTruthy();
    });

    it('shows a collapsed single-child chain as one row', () => {
      renderTree([f('aws/edge/terraform/iam.tf'), f('aws/edge/terraform/vars.tf')]);
      expect(screen.getByText('aws/edge/terraform')).toBeTruthy();
    });

    it('shows the file name only, not its full path, on a file row', () => {
      renderTree([f('src/deep/thing.ts')]);
      expect(screen.queryByText('src/deep/thing.ts')).toBeNull();
      expect(screen.getByText('thing.ts')).toBeTruthy();
    });
  });

  describe('selection', () => {
    it('calls onSelect with the full path when a file is clicked', () => {
      const { onSelect } = renderTree([f('src/deep/thing.ts')]);
      fireEvent.click(screen.getByText('thing.ts'));
      expect(onSelect).toHaveBeenCalledWith('src/deep/thing.ts');
    });

    it('marks the selected file so it is distinguishable', () => {
      renderTree([f('a.ts'), f('b.ts')], 'b.ts');
      const selected = screen.getByRole('treeitem', { selected: true });
      expect(within(selected).getByText('b.ts')).toBeTruthy();
    });

    it('marks nothing selected when selectedPath is null', () => {
      renderTree([f('a.ts')], null);
      expect(screen.queryByRole('treeitem', { selected: true })).toBeNull();
    });

    it('does not call onSelect when a directory row is clicked', () => {
      const { onSelect } = renderTree([f('src/a.ts')]);
      fireEvent.click(screen.getByText('src'));
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  describe('folding', () => {
    it('shows directory children by default', () => {
      renderTree([f('src/a.ts')]);
      expect(screen.getByText('a.ts')).toBeTruthy();
    });

    it('hides children after the directory is clicked', () => {
      renderTree([f('src/a.ts')]);
      fireEvent.click(screen.getByText('src'));
      expect(screen.queryByText('a.ts')).toBeNull();
    });

    it('shows them again on a second click', () => {
      renderTree([f('src/a.ts')]);
      fireEvent.click(screen.getByText('src'));
      fireEvent.click(screen.getByText('src'));
      expect(screen.getByText('a.ts')).toBeTruthy();
    });
  });

  describe('status', () => {
    it('labels an untracked file as added', () => {
      renderTree([f('new.ts', { status: 'untracked' })]);
      expect(screen.getByLabelText(/untracked/i)).toBeTruthy();
    });

    it('labels a deleted file', () => {
      renderTree([f('gone.ts', { status: 'deleted' })]);
      expect(screen.getByLabelText(/deleted/i)).toBeTruthy();
    });

    it('labels a staged file as staged', () => {
      renderTree([f('a.ts', { staged: true })]);
      expect(screen.getByLabelText(/staged/i)).toBeTruthy();
    });
  });

  describe('filtering', () => {
    const files = [f('src/components/Button.tsx'), f('src/lib/api.ts'), f('README.md')];

    it('narrows the tree to matching paths', () => {
      renderTree(files);
      fireEvent.change(screen.getByPlaceholderText(/filter files/i), {
        target: { value: 'Button' },
      });
      expect(screen.getByText('Button.tsx')).toBeTruthy();
      expect(screen.queryByText('README.md')).toBeNull();
    });

    it('matches on directory segments, not just file names', () => {
      renderTree(files);
      fireEvent.change(screen.getByPlaceholderText(/filter files/i), {
        target: { value: 'lib' },
      });
      expect(screen.getByText('api.ts')).toBeTruthy();
      expect(screen.queryByText('Button.tsx')).toBeNull();
    });

    it('says nothing matched rather than showing an empty pane', () => {
      renderTree(files);
      fireEvent.change(screen.getByPlaceholderText(/filter files/i), {
        target: { value: 'zzzz' },
      });
      expect(screen.getByText(/no files match/i)).toBeTruthy();
    });

    it('restores the full tree when the filter is cleared', () => {
      renderTree(files);
      const box = screen.getByPlaceholderText(/filter files/i);
      fireEvent.change(box, { target: { value: 'Button' } });
      fireEvent.change(box, { target: { value: '' } });
      expect(screen.getByText('README.md')).toBeTruthy();
    });
  });

  describe('empty input', () => {
    it('says there are no changes rather than rendering an empty tree', () => {
      renderTree([]);
      expect(screen.getByText(/no changes/i)).toBeTruthy();
    });
  });
});
