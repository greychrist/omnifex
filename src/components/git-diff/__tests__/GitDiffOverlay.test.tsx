// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';

const listGitChangedFiles = vi.fn();
const getGitFileDiff = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    listGitChangedFiles: (...a: unknown[]) => listGitChangedFiles(...a),
    getGitFileDiff: (...a: unknown[]) => getGitFileDiff(...a),
  },
}));
vi.mock('react-syntax-highlighter', () => ({
  Prism: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/hooks', () => ({ useTheme: () => ({ theme: 'dark' }) }));

import { GitDiffOverlay } from '@/components/git-diff/GitDiffOverlay';
import type { GitChangedFile } from '@/lib/api';

const f = (path: string, over: Partial<GitChangedFile> = {}): GitChangedFile => ({
  path,
  status: 'modified',
  staged: false,
  ...over,
});

function patchFor(path: string, adds = 1, dels = 1): string {
  const lines = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -10,2 +10,2 @@',
  ];
  for (let i = 0; i < dels; i++) lines.push(`-old${i}-${path}`);
  for (let i = 0; i < adds; i++) lines.push(`+new${i}-${path}`);
  lines.push('');
  return lines.join('\n');
}

beforeEach(() => {
  listGitChangedFiles.mockReset();
  getGitFileDiff.mockReset();
  listGitChangedFiles.mockResolvedValue([]);
  getGitFileDiff.mockResolvedValue('');
});

afterEach(() => { cleanup(); });

const renderOverlay = (props: Partial<React.ComponentProps<typeof GitDiffOverlay>> = {}) => {
  const onClose = vi.fn();
  const utils = render(
    <GitDiffOverlay projectPath="/p" onClose={onClose} {...props} />,
  );
  return { onClose, ...utils };
};

describe('GitDiffOverlay', () => {
  describe('loading the file list', () => {
    it('reads the changed files for the project', async () => {
      renderOverlay();
      await waitFor(() => {
        expect(listGitChangedFiles).toHaveBeenCalledWith('/p');
      });
    });

    it('shows the files in the navigator', async () => {
      listGitChangedFiles.mockResolvedValue([f('src/a.ts'), f('src/b.ts')]);
      renderOverlay();
      expect(await screen.findByText('a.ts')).toBeTruthy();
      expect(screen.getByText('b.ts')).toBeTruthy();
    });

    it('says the tree is clean when nothing changed', async () => {
      listGitChangedFiles.mockResolvedValue([]);
      renderOverlay();
      expect(await screen.findByText(/no changes/i)).toBeTruthy();
    });

    it('reports a failed read instead of claiming the tree is clean', async () => {
      listGitChangedFiles.mockRejectedValue(new Error('git exploded'));
      renderOverlay();
      expect(await screen.findByText(/could not read/i)).toBeTruthy();
    });
  });

  describe('selecting a file', () => {
    it('opens the first file automatically so the pane is never blank', async () => {
      listGitChangedFiles.mockResolvedValue([f('src/a.ts'), f('src/b.ts')]);
      getGitFileDiff.mockImplementation((_p: string, path: string) =>
        Promise.resolve(patchFor(path)),
      );
      renderOverlay();

      await waitFor(() => {
        expect(getGitFileDiff).toHaveBeenCalledWith('/p', 'src/a.ts', 3);
      });
      expect(await screen.findByText('new0-src/a.ts')).toBeTruthy();
    });

    it('loads the patch for a file that is clicked', async () => {
      listGitChangedFiles.mockResolvedValue([f('src/a.ts'), f('src/b.ts')]);
      getGitFileDiff.mockImplementation((_p: string, path: string) =>
        Promise.resolve(patchFor(path)),
      );
      renderOverlay();
      await screen.findByText('new0-src/a.ts');

      fireEvent.click(screen.getByText('b.ts'));
      expect(await screen.findByText('new0-src/b.ts')).toBeTruthy();
    });

    it('shows the selected file path in the header', async () => {
      listGitChangedFiles.mockResolvedValue([f('src/deep/a.ts')]);
      getGitFileDiff.mockResolvedValue(patchFor('src/deep/a.ts'));
      renderOverlay();
      expect(await screen.findByTestId('diff-header-path')).toHaveProperty(
        'textContent',
        'src/deep/a.ts',
      );
    });

    it('shows added and removed counts for the selected file', async () => {
      listGitChangedFiles.mockResolvedValue([f('a.ts')]);
      getGitFileDiff.mockResolvedValue(patchFor('a.ts', 5, 2));
      renderOverlay();
      expect(await screen.findByText('+5')).toBeTruthy();
      expect(screen.getByText('−2')).toBeTruthy();
    });

    it('says so when a file has no renderable patch', async () => {
      listGitChangedFiles.mockResolvedValue([f('a.ts')]);
      getGitFileDiff.mockResolvedValue('');
      renderOverlay();
      expect(await screen.findByText(/no diff to show/i)).toBeTruthy();
    });

    it('reports a failed patch read', async () => {
      listGitChangedFiles.mockResolvedValue([f('a.ts')]);
      getGitFileDiff.mockRejectedValue(new Error('nope'));
      renderOverlay();
      expect(await screen.findByText(/could not read/i)).toBeTruthy();
    });
  });

  describe('expanding context', () => {
    it('re-reads the patch with more context when a gap is expanded', async () => {
      listGitChangedFiles.mockResolvedValue([f('a.ts')]);
      getGitFileDiff.mockResolvedValue(patchFor('a.ts'));
      renderOverlay();
      await screen.findByText('new0-a.ts');

      fireEvent.click(screen.getAllByRole('button', { name: /expand/i })[0]);

      await waitFor(() => {
        const contexts = getGitFileDiff.mock.calls.map((c) => c[2]);
        expect(Math.max(...contexts)).toBeGreaterThan(3);
      });
    });

    it('resets the context width when a different file is opened', async () => {
      listGitChangedFiles.mockResolvedValue([f('a.ts'), f('b.ts')]);
      getGitFileDiff.mockImplementation((_p: string, path: string) =>
        Promise.resolve(patchFor(path)),
      );
      renderOverlay();
      await screen.findByText('new0-a.ts');
      fireEvent.click(screen.getAllByRole('button', { name: /expand/i })[0]);
      await waitFor(() => { expect(getGitFileDiff.mock.calls.length).toBe(2); });

      fireEvent.click(screen.getByText('b.ts'));
      await waitFor(() => {
        expect(getGitFileDiff).toHaveBeenCalledWith('/p', 'b.ts', 3);
      });
    });
  });

  describe('closing', () => {
    it('closes when the close button is pressed', async () => {
      const { onClose } = renderOverlay();
      fireEvent.click(await screen.findByRole('button', { name: /close/i }));
      expect(onClose).toHaveBeenCalled();
    });

    it('closes on Escape', async () => {
      const { onClose } = renderOverlay();
      await waitFor(() => { expect(listGitChangedFiles).toHaveBeenCalled(); });
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('refreshing', () => {
    // Nested paths on purpose: a root-level `a.ts` renders BOTH as a tree row
    // and as the header path, so a bare getByText('a.ts') is ambiguous.
    it('re-reads the file list when refreshToken changes', async () => {
      listGitChangedFiles.mockResolvedValue([f('src/a.ts')]);
      const { rerender, onClose } = renderOverlay({ refreshToken: 1 });
      await screen.findByText('a.ts');

      listGitChangedFiles.mockResolvedValue([f('src/a.ts'), f('src/c.ts')]);
      rerender(
        <GitDiffOverlay projectPath="/p" onClose={onClose} refreshToken={2} />,
      );
      expect(await screen.findByText('c.ts')).toBeTruthy();
    });

    it('does not re-read on an unrelated re-render', async () => {
      listGitChangedFiles.mockResolvedValue([f('src/a.ts')]);
      const { rerender, onClose } = renderOverlay({ refreshToken: 1 });
      await screen.findByText('a.ts');
      rerender(
        <GitDiffOverlay projectPath="/p" onClose={onClose} refreshToken={1} />,
      );
      await waitFor(() => {
        expect(listGitChangedFiles).toHaveBeenCalledTimes(1);
      });
    });

    it('keeps the selected file selected across a refresh', async () => {
      listGitChangedFiles.mockResolvedValue([f('a.ts'), f('b.ts')]);
      getGitFileDiff.mockImplementation((_p: string, path: string) =>
        Promise.resolve(patchFor(path)),
      );
      const { rerender, onClose } = renderOverlay({ refreshToken: 1 });
      await screen.findByText('new0-a.ts');
      fireEvent.click(screen.getByText('b.ts'));
      await screen.findByText('new0-b.ts');

      rerender(
        <GitDiffOverlay projectPath="/p" onClose={onClose} refreshToken={2} />,
      );

      expect(await screen.findByTestId('diff-header-path')).toHaveProperty(
        'textContent',
        'b.ts',
      );
    });
  });
});
