// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const listClaudeInstallations = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    listClaudeInstallations: (...a: unknown[]) => listClaudeInstallations(...a),
    revealPathInFinder: vi.fn(),
  },
}));

import { ClaudeVersionSelector } from '../ClaudeVersionSelector';

const INSTALLS = [
  { path: '/Users/me/.local/bin/claude', version: '2.1.287', source: 'native', installation_type: 'System' },
  { path: '/opt/homebrew/bin/claude', version: '2.1.280', source: 'homebrew', installation_type: 'System' },
];

beforeEach(() => { listClaudeInstallations.mockResolvedValue(INSTALLS); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ClaudeVersionSelector', () => {
  it('picks the best installation for a caller with no selection, by default', async () => {
    const onSelect = vi.fn();
    render(<ClaudeVersionSelector selectedPath={null} onSelect={onSelect} simplified />);
    await waitFor(() => { expect(onSelect).toHaveBeenCalledWith(INSTALLS[0]); });
  });

  it('reports nothing it was not asked to pick when autoSelect is off', async () => {
    const onSelect = vi.fn();
    render(
      <ClaudeVersionSelector selectedPath={null} onSelect={onSelect} simplified autoSelect={false} />,
    );
    await screen.findByText(/automatic/i);
    expect(listClaudeInstallations).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows the saved installation once its path arrives, after the list', async () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <ClaudeVersionSelector selectedPath={null} onSelect={onSelect} simplified autoSelect={false} />,
    );
    await screen.findByText(/automatic/i);
    rerender(
      <ClaudeVersionSelector selectedPath={INSTALLS[1].path} onSelect={onSelect} simplified autoSelect={false} />,
    );
    expect(await screen.findByText('(2.1.280)')).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
