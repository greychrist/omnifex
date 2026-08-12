// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { BrainTab } from '@/components/brain/BrainTab';
import { api, type BrainVaultStatus } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    brainStatus: vi.fn(),
    brainListNotes: vi.fn(),
    brainRebuild: vi.fn(),
    brainSetVaultPath: vi.fn(),
    brainClearVaultPath: vi.fn(),
  },
}));

vi.mock('@/contexts/AccountsContext', () => ({
  useAccounts: () => ({
    accounts: [
      { id: 7, name: 'personal' },
      { id: 9, name: 'work' },
    ],
    getColor: () => null,
    getIcon: () => null,
    getAccountType: () => 'max',
  }),
}));

// The panes have their own tests; here they only report what they were handed,
// which is what makes the account-scoping assertions below meaningful.
vi.mock('@/components/brain/BrainNoteList', () => ({
  BrainNoteList: ({ accountId, notes }: { accountId: number | null; notes: string[] }) => (
    <div data-testid="note-list">{`${String(accountId)}:${notes.join(',')}`}</div>
  ),
}));
vi.mock('@/components/brain/BrainNoteViewer', () => ({
  BrainNoteViewer: () => <div data-testid="note-viewer" />,
}));
vi.mock('@/components/brain/BrainVaultSetup', () => ({
  BrainVaultSetup: () => <div data-testid="vault-setup" />,
}));

// AccountBadge reaches for ThemeProvider; its own rendering is covered by
// AccountBadge.test.tsx. Here it only needs to report which account it got.
vi.mock('@/components/AccountBadge', () => ({
  AccountBadge: ({ name }: { name: string }) => <span data-testid="account-badge">{name}</span>,
}));

function status(over: Partial<BrainVaultStatus> = {}): BrainVaultStatus {
  return {
    accountId: 7, configured: true, path: '/v', exists: true, initialized: true,
    noteCount: 2, indexedCount: 2, gitAvailable: true, lastGitError: null,
    conflict: null, ...over,
  };
}

describe('BrainTab', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(api.brainStatus).mockImplementation((id) => Promise.resolve(status({ accountId: id })));
    vi.mocked(api.brainListNotes).mockResolvedValue(['Notes/A.md', 'Notes/B.md']);
  });

  it('selects the first account on mount rather than rendering empty', async () => {
    render(<BrainTab />);
    await waitFor(() => { expect(api.brainStatus).toHaveBeenCalledWith(7); });
  });

  it('shows the three-pane view for a healthy vault', async () => {
    render(<BrainTab />);
    await waitFor(() => { expect(screen.getByTestId('note-list')).toBeTruthy(); });
    expect(screen.queryByTestId('vault-setup')).toBeNull();
  });

  it('passes the selected account and only that account notes to the list', async () => {
    render(<BrainTab />);
    await waitFor(() => {
      expect(screen.getByTestId('note-list').textContent).toBe('7:Notes/A.md,Notes/B.md');
    });
  });

  it('routes an unconfigured vault to the setup panel', async () => {
    vi.mocked(api.brainStatus).mockResolvedValue(status({ configured: false, path: null, exists: false }));
    render(<BrainTab />);
    await waitFor(() => { expect(screen.getByTestId('vault-setup')).toBeTruthy(); });
    expect(screen.queryByTestId('note-list')).toBeNull();
  });

  it('routes a missing directory to the setup panel', async () => {
    vi.mocked(api.brainStatus).mockResolvedValue(status({ exists: false }));
    render(<BrainTab />);
    await waitFor(() => { expect(screen.getByTestId('vault-setup')).toBeTruthy(); });
  });

  it('routes a conflicting vault to the setup panel', async () => {
    vi.mocked(api.brainStatus).mockResolvedValue(status({ conflict: 'overlaps another account' }));
    render(<BrainTab />);
    await waitFor(() => { expect(screen.getByTestId('vault-setup')).toBeTruthy(); });
  });

  it('summarises note count in the header', async () => {
    render(<BrainTab />);
    await waitFor(() => {
      expect(screen.getByTestId('brain-summary').textContent).toBe('2 notes');
    });
  });

  it('says "vault missing" rather than "0 notes" when the directory is gone', async () => {
    vi.mocked(api.brainStatus).mockResolvedValue(status({ exists: false, noteCount: 0 }));
    render(<BrainTab />);
    await waitFor(() => {
      expect(screen.getByTestId('brain-summary').textContent).toBe('vault missing');
    });
  });

  it('opens the vault panel for a healthy vault via the header toggle', async () => {
    render(<BrainTab />);
    await waitFor(() => { expect(screen.getByTestId('note-list')).toBeTruthy(); });

    // Without this route the rebuild and disconnect controls would only be
    // reachable by first BREAKING the vault.
    fireEvent.click(screen.getByRole('button', { name: /vault/i }));
    expect(screen.getByTestId('vault-setup')).toBeTruthy();
    expect(screen.queryByTestId('note-list')).toBeNull();
  });

  it('closes the vault panel again on a second click', async () => {
    render(<BrainTab />);
    await waitFor(() => { expect(screen.getByTestId('note-list')).toBeTruthy(); });

    const toggle = screen.getByRole('button', { name: /vault/i });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(screen.getByTestId('note-list')).toBeTruthy();
  });

  it('does not offer the toggle when the vault is already routed to setup', async () => {
    vi.mocked(api.brainStatus).mockResolvedValue(status({ configured: false, path: null, exists: false }));
    render(<BrainTab />);
    await waitFor(() => { expect(screen.getByTestId('vault-setup')).toBeTruthy(); });
    expect(screen.queryByRole('button', { name: /vault/i })).toBeNull();
  });

  it('surfaces a load error', async () => {
    vi.mocked(api.brainStatus).mockRejectedValue(new Error('disk on fire'));
    render(<BrainTab />);
    await waitFor(() => { expect(screen.getByText(/disk on fire/)).toBeTruthy(); });
  });
});
