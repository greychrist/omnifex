// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { BrainTab } from '@/components/brain/BrainTab';
import { api, type BrainNoteMeta, type BrainVaultStatus } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    brainStatus: vi.fn(),
    brainListNoteMeta: vi.fn(),
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

vi.mock('@/components/brain/BrainNotesTable', () => ({
  BrainNotesTable: (
    {
      accountId, notes, onSelect,
    }: {
      accountId: number | null;
      notes: { relPath: string }[];
      onSelect: (relPath: string) => void;
    },
  ) => (
    <div data-testid="note-list">
      {`${String(accountId)}:${notes.map((n) => n.relPath).join(',')}`}
      {/* Labelled rather than captioned, so this node's textContent stays the
          account id and paths the sibling tests assert on. */}
      <button
        type="button"
        aria-label="open a note"
        onClick={() => { onSelect('Notes/A.md'); }}
      />
    </div>
  ),
}));
vi.mock('@/components/brain/BrainNoteViewer', () => ({
  BrainNoteViewer: ({ onClose }: { onClose?: () => void }) => (
    <div data-testid="note-viewer">
      <button type="button" aria-label="close the note" onClick={onClose} />
    </div>
  ),
}));
vi.mock('@/components/brain/BrainVaultSetup', () => ({
  BrainVaultSetup: () => <div data-testid="vault-setup" />,
}));
vi.mock('@/components/brain/BrainSources', () => ({
  BrainSources: (
    { accountId, onVaultChanged }: { accountId: number | null; onVaultChanged?: () => void },
  ) => (
    <div data-testid="sources">
      {String(accountId)}
      {/* Labelled rather than captioned: text here would join this node's
          textContent, which sibling tests assert is the account id alone. */}
      <button type="button" aria-label="fire vault changed" onClick={onVaultChanged} />
    </div>
  ),
}));
vi.mock('@/components/brain/BrainQueuePanel', () => ({
  BrainAutomationSettings: ({ accountId }: { accountId: number | null }) => (
    <div data-testid="automation-settings">{String(accountId)}</div>
  ),
}));
vi.mock('@/components/brain/BrainStatsPanel', () => ({
  BrainStatsPanel: ({ accountId, nonce }: { accountId: number | null; nonce?: number }) => (
    <div data-testid="stats" data-nonce={String(nonce ?? 'undefined')}>{String(accountId)}</div>
  ),
}));

// Radix's Select is a button plus portal jsdom cannot drive; these stand-ins
// keep its contract.
const SelectValueCtx = React.createContext<(v: string) => void>(() => undefined);
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value, onValueChange, children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <SelectValueCtx.Provider value={onValueChange}>
      <div data-testid="account-select" data-value={value}>{children}</div>
    </SelectValueCtx.Provider>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="account-select-trigger">{children}</div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
    const onValueChange = React.useContext(SelectValueCtx);
    return (
      <button
        type="button"
        data-testid={`account-option-${value}`}
        onClick={() => { onValueChange(value); }}
      >
        {children}
      </button>
    );
  },
}));

vi.mock('@/components/AccountBadge', () => ({
  AccountBadge: ({ name }: { name: string }) => <span data-testid="account-badge">{name}</span>,
}));

function status(over: Partial<BrainVaultStatus> = {}): BrainVaultStatus {
  return {
    accountId: 7, configured: true, path: '/v', exists: true, initialized: true,
    noteCount: 2, indexedCount: 2, gitAvailable: true, lastGitError: null,
    conflict: null, offloadedCount: null, ...over,
  };
}

function noteMeta(relPath: string): BrainNoteMeta {
  return {
    relPath,
    title: relPath.split('/').pop()?.replace(/\.md$/, '') ?? relPath,
    type: 'Note',
    project: null,
    created: '2026-08-01',
    updated: '2026-08-01',
    curatedAt: null,
  };
}

describe('BrainTab', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(api.brainStatus).mockImplementation((id) => Promise.resolve(status({ accountId: id })));
    vi.mocked(api.brainListNoteMeta).mockResolvedValue([noteMeta('Notes/A.md'), noteMeta('Notes/B.md')]);
  });

  it('opens the note pane on select and puts it away on close', async () => {
    render(<BrainTab />);
    await waitFor(() => { expect(screen.getByTestId('note-list')).toBeTruthy(); });
    expect(screen.queryByTestId('note-viewer')).toBeNull();

    fireEvent.click(screen.getByLabelText('open a note'));
    expect(screen.getByTestId('note-viewer')).toBeTruthy();
    expect(screen.getByRole('separator', { name: /resize the note list/i })).toBeTruthy();

    fireEvent.click(screen.getByLabelText('close the note'));
    expect(screen.queryByTestId('note-viewer')).toBeNull();
    expect(screen.queryByRole('separator', { name: /resize the note list/i })).toBeNull();
  });

  it('selects the first account on mount rather than rendering empty', async () => {
    render(<BrainTab />);
    await waitFor(() => { expect(api.brainStatus).toHaveBeenCalledWith(7); });
  });

  it('refreshes the stats bar when the sources pane reports a vault change', async () => {
    render(<BrainTab />);
    const before = (await screen.findByTestId('stats')).getAttribute('data-nonce');
    fireEvent.click(await screen.findByRole('tab', { name: /^sources$/i }));

    fireEvent.click(await screen.findByRole('button', { name: /fire vault changed/i }));

    await waitFor(() => {
      expect(screen.getByTestId('stats').getAttribute('data-nonce')).not.toBe(before);
    });
  });

  it('never leaves the stats nonce undefined', async () => {
    render(<BrainTab />);
    const stats = await screen.findByTestId('stats');
    expect(stats.getAttribute('data-nonce')).not.toBe('undefined');
  });

  it('re-reads the vault status on a vault change, so the note count keeps up', async () => {
    render(<BrainTab />);
    await waitFor(() => { expect(api.brainStatus).toHaveBeenCalledWith(7); });
    fireEvent.click(await screen.findByRole('tab', { name: /^sources$/i }));
    const before = vi.mocked(api.brainStatus).mock.calls.length;

    fireEvent.click(await screen.findByRole('button', { name: /fire vault changed/i }));

    await waitFor(() => {
      expect(vi.mocked(api.brainStatus).mock.calls.length).toBeGreaterThan(before);
    });
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

  it('renders neither the panes nor the stats bar while the status is unknown', async () => {
    let resolveStatus: (s: BrainVaultStatus) => void = () => {};
    vi.mocked(api.brainStatus).mockReturnValue(
      new Promise<BrainVaultStatus>((r) => { resolveStatus = r; }),
    );

    render(<BrainTab />);
    await waitFor(() => { expect(api.brainStatus).toHaveBeenCalledWith(7); });

    expect(screen.queryByTestId('note-list')).toBeNull();
    expect(screen.queryByTestId('stats')).toBeNull();
    expect(screen.queryByTestId('vault-setup')).toBeNull();

    resolveStatus(status({ configured: false, path: null, exists: false }));
    await waitFor(() => { expect(screen.getByTestId('vault-setup')).toBeTruthy(); });
    expect(screen.queryByTestId('note-list')).toBeNull();
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

  it('reaches vault management from the Settings tab on a healthy vault', async () => {
    render(<BrainTab />);
    await waitFor(() => { expect(screen.getByTestId('note-list')).toBeTruthy(); });

    fireEvent.click(screen.getByRole('tab', { name: /settings/i }));
    expect(screen.getByTestId('vault-setup')).toBeTruthy();
    expect(screen.getByTestId('automation-settings')).toBeTruthy();
    expect(screen.queryByTestId('note-list')).toBeNull();
  });

  it('goes back to the notes from Settings', async () => {
    render(<BrainTab />);
    await waitFor(() => { expect(screen.getByTestId('note-list')).toBeTruthy(); });

    fireEvent.click(screen.getByRole('tab', { name: /settings/i }));
    fireEvent.click(screen.getByRole('tab', { name: /^notes$/i }));
    expect(screen.getByTestId('note-list')).toBeTruthy();
  });

  it('forces Settings and disables the other tabs while a vault needs setup', async () => {
    vi.mocked(api.brainStatus).mockResolvedValue(status({ configured: false, path: null, exists: false }));
    render(<BrainTab />);
    await waitFor(() => { expect(screen.getByTestId('vault-setup')).toBeTruthy(); });

    expect(screen.getByRole<HTMLButtonElement>('tab', { name: /^notes$/i }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('tab', { name: /^sources$/i }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('tab', { name: /settings/i }).disabled).toBe(false);
    expect(screen.getByTestId('account-select')).toBeTruthy();
    expect(screen.queryByTestId('stats')).toBeNull();
  });

  it('does not blank the header summary between accounts', async () => {
    let resolveStatus: (s: BrainVaultStatus) => void = () => {};
    vi.mocked(api.brainStatus).mockReturnValue(
      new Promise<BrainVaultStatus>((r) => { resolveStatus = r; }),
    );

    render(<BrainTab />);
    await waitFor(() => { expect(api.brainStatus).toHaveBeenCalledWith(7); });

    expect(screen.getByTestId('brain-summary').textContent).toBe('loading…');

    resolveStatus(status({ configured: false, path: null, exists: false }));
    await waitFor(() => {
      expect(screen.getByTestId('brain-summary').textContent).toBe('no vault');
    });
  });

  it('surfaces a load error', async () => {
    vi.mocked(api.brainStatus).mockRejectedValue(new Error('disk on fire'));
    render(<BrainTab />);
    await waitFor(() => { expect(screen.getByText(/disk on fire/)).toBeTruthy(); });
  });

  it('switches between the notes and sources panes', async () => {
    render(<BrainTab />);
    await waitFor(() => { expect(screen.getByTestId('note-list')).toBeTruthy(); });

    fireEvent.click(screen.getByRole('tab', { name: /^sources$/i }));
    expect(screen.getByTestId('sources')).toBeTruthy();
    expect(screen.queryByTestId('note-list')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /^notes$/i }));
    expect(screen.getByTestId('note-list')).toBeTruthy();
  });

  it('hands the sources pane the selected account, and resets to notes on a switch', async () => {
    render(<BrainTab />);
    await waitFor(() => { expect(screen.getByTestId('note-list')).toBeTruthy(); });

    fireEvent.click(screen.getByRole('tab', { name: /^sources$/i }));
    expect(screen.getByTestId('sources').textContent).toBe('7');

    fireEvent.click(screen.getByTestId('account-option-work'));
    await waitFor(() => { expect(screen.getByTestId('note-list')).toBeTruthy(); });
  });
});

describe('BrainTab — account switcher placement', () => {
  // The suite above scopes its beforeEach to its own describe.
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(api.brainStatus).mockImplementation((id) => Promise.resolve(status({ accountId: id })));
    vi.mocked(api.brainListNoteMeta).mockResolvedValue([noteMeta('Notes/A.md'), noteMeta('Notes/B.md')]);
  });

  it('leads with a hero title and blurb, then one card holding the rest', async () => {
    render(<BrainTab />);
    await screen.findByTestId('account-select');

    const title = screen.getByRole('heading', { level: 1, name: 'Brain' });
    expect(title).toBeTruthy();
    expect(screen.getByText(/vault of what you have already worked on/i)).toBeTruthy();
    expect(title.compareDocumentPosition(screen.getByTestId('account-select'))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('names the selected vault at the top left and the account at the top right', async () => {
    render(<BrainTab />);
    await screen.findByTestId('account-select');

    const heading = await screen.findByRole('heading', { level: 2 });
    expect(heading.textContent).toContain('personal Brain');
    await waitFor(() => {
      expect(screen.getByTestId('brain-summary').textContent).toBe('2 notes');
    });
    expect(heading.compareDocumentPosition(screen.getByTestId('account-select'))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers Notes, Sources and Settings — no Vault tab', async () => {
    render(<BrainTab />);
    await screen.findByTestId('account-select');
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.trim());
    expect(tabs).toEqual(['Notes', 'Sources', 'Settings']);
  });

  it('renders the account badge inside the trigger, not a bare name', async () => {
    render(<BrainTab />);
    const trigger = await screen.findByTestId('account-select-trigger');
    expect(within(trigger).getByTestId('account-badge').textContent).toBe('personal');
  });

  it('offers every account as a badge in the list', async () => {
    render(<BrainTab />);
    await screen.findByTestId('account-select');
    expect(within(screen.getByTestId('account-option-personal')).getByTestId('account-badge')).toBeTruthy();
    expect(within(screen.getByTestId('account-option-work')).getByTestId('account-badge')).toBeTruthy();
  });

  it('keeps the switcher reachable on a vault that needs setup', async () => {
    vi.mocked(api.brainStatus).mockResolvedValue(status({ configured: false }));
    render(<BrainTab />);
    await screen.findByTestId('vault-setup');
    expect(screen.getByTestId('account-select')).toBeTruthy();
    expect(screen.queryByTestId('stats')).toBeNull();
  });
});
