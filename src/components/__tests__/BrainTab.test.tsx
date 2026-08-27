// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { BrainTab } from '@/components/brain/BrainTab';
import { api, type BrainVaultStatus } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    brainStatus: vi.fn(),
    brainListNotes: vi.fn(),
    brainRebuild: vi.fn(),
    brainSetVaultPath: vi.fn(),
    brainClearVaultPath: vi.fn(),
    // The Settings tab now also shows what OmniFex's own retained transcripts
    // occupy. Stubbed to empty so these tests stay about the Brain.
    internalArchiveStats: vi.fn(async () => ({ files: 0, bytes: 0 })),
    internalArchiveClear: vi.fn(async () => ({ files: 0, bytes: 0 })),
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
vi.mock('@/components/brain/BrainSources', () => ({
  // Exposes the vault-changed callback as a button, so a test can fire the
  // thing an indexing run or a Refresh press fires.
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
  // Reports the nonce it was handed: the real panel's fetch effect keys on it,
  // so "did BrainTab bump it?" is the whole question.
  BrainStatsPanel: ({ accountId, nonce }: { accountId: number | null; nonce?: number }) => (
    <div data-testid="stats" data-nonce={String(nonce ?? 'undefined')}>{String(accountId)}</div>
  ),
}));

// Radix's Select renders a button-plus-portal that jsdom cannot drive. These
// stand-ins keep the same contract — a current value, items that report their
// own value on press, and a trigger that renders whatever it was given — which
// is what this file tests: what the account switcher DOES, and that the
// trigger carries the badge, not how Radix paints either.
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

  /**
   * The stats bar reads `brain_stats`, which the Sources pane cannot reach: it
   * is a sibling, not a child. So an indexing run updated the rows and left
   * "Spent indexing" showing a figure from before the spend — and pressing
   * Refresh in Sources did not help, because it only re-lists that pane. The
   * only thing that ever corrected it was closing and reopening the tab.
   */
  it('refreshes the stats bar when the sources pane reports a vault change', async () => {
    render(<BrainTab />);
    const before = (await screen.findByTestId('stats')).getAttribute('data-nonce');
    // The pane only exists on its own tab; the default is Notes.
    fireEvent.click(await screen.findByRole('tab', { name: /^sources$/i }));

    fireEvent.click(await screen.findByRole('button', { name: /fire vault changed/i }));

    await waitFor(() => {
      expect(screen.getByTestId('stats').getAttribute('data-nonce')).not.toBe(before);
    });
  });

  it('never leaves the stats nonce undefined', async () => {
    // Passing no nonce at all is the bug this guards: the panel defaults it to
    // 0, so its fetch effect never re-runs and the figures freeze on mount.
    render(<BrainTab />);
    const stats = await screen.findByTestId('stats');
    expect(stats.getAttribute('data-nonce')).not.toBe('undefined');
  });

  /** The header's note count comes from the vault status, not from stats. */
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

  /**
   * The flash this pins.
   *
   * `useBrainVault` clears `status` to null synchronously on switch, by design.
   * `needsSetup` derives from `status`, so while the read is in flight it is
   * false — "unknown yet" fell through to the HEALTHY branch. On an
   * unconfigured account every switch therefore rendered
   * setup → notes+stats → setup, a full pane swap and back, right under the
   * header where "no vault" is shown.
   *
   * Unknown is not healthy. Until the status lands, neither branch may render.
   */
  it('renders neither the panes nor the stats bar while the status is unknown', async () => {
    let resolveStatus: (s: BrainVaultStatus) => void = () => {};
    vi.mocked(api.brainStatus).mockReturnValue(
      new Promise<BrainVaultStatus>((r) => { resolveStatus = r; }),
    );

    render(<BrainTab />);
    await waitFor(() => { expect(api.brainStatus).toHaveBeenCalledWith(7); });

    // Mid-flight: the healthy branch must not be showing.
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

    // Without this route the rebuild and disconnect controls would only be
    // reachable by first BREAKING the vault.
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
    // The old shell REPLACED the page with the setup panel, which hid the
    // account switcher too — so a broken vault stranded the user on the very
    // account they wanted to leave. Now it is a tab, and the rest are refused
    // rather than removed.
    vi.mocked(api.brainStatus).mockResolvedValue(status({ configured: false, path: null, exists: false }));
    render(<BrainTab />);
    await waitFor(() => { expect(screen.getByTestId('vault-setup')).toBeTruthy(); });

    expect((screen.getByRole('tab', { name: /^notes$/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('tab', { name: /^sources$/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('tab', { name: /settings/i }) as HTMLButtonElement).disabled).toBe(false);
    // The way out of a broken vault stays reachable.
    expect(screen.getByTestId('account-select')).toBeTruthy();
    // Four zeroes would read as a fact rather than as an absence.
    expect(screen.queryByTestId('stats')).toBeNull();
  });

  /**
   * The header summary is the element the flash was reported next to, so it is
   * pinned here — but note what this does and does not show.
   *
   * `headerSummary` reads `status` and `loading`, which are set on different
   * ticks: on switch `status` clears synchronously while `loading` is still
   * false, so there is a committed render where it returns ''. This test was
   * written expecting to catch that and it passed unchanged — React flushes
   * the passive effect that sets `loading` before the browser paints, so the
   * blank frame is committed but never seen. The reported flash was the pane
   * swap above, not this.
   *
   * Kept as a guard: the summary must go straight to 'loading…' and then to
   * the answer, never through a blank.
   */
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
    // Landing back on notes after a switch is deliberate: the sources list is
    // a scan of another account's config dir, and silently re-running it under
    // a new account reads as if the previous list simply updated.
    await waitFor(() => { expect(screen.getByTestId('note-list')).toBeTruthy(); });
  });
});

// The page was restyled to match Projects: a hero title and blurb above a
// single card, the vault's own name and count at the card's top left, and the
// account selector at its top right.
describe('BrainTab — account switcher placement', () => {
  // Its own setup: the suite above scopes `beforeEach` to its own describe, so
  // without this the status mock returns undefined and nothing renders.
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(api.brainStatus).mockImplementation((id) => Promise.resolve(status({ accountId: id })));
    vi.mocked(api.brainListNotes).mockResolvedValue(['Notes/A.md', 'Notes/B.md']);
  });

  it('leads with a hero title and blurb, then one card holding the rest', async () => {
    render(<BrainTab />);
    await screen.findByTestId('account-select');

    const title = screen.getByRole('heading', { level: 1, name: 'Brain' });
    expect(title).toBeTruthy();
    // A blurb saying what the page is for, the way Projects does.
    expect(screen.getByText(/vault of what you have already worked on/i)).toBeTruthy();
    // The working surface sits below the hero, not beside it.
    expect(title.compareDocumentPosition(screen.getByTestId('account-select'))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('names the selected vault at the top left and the account at the top right', async () => {
    render(<BrainTab />);
    await screen.findByTestId('account-select');

    // "personal Brain (2 notes)" — the shape "Recent Projects (12)" uses.
    const heading = await screen.findByRole('heading', { level: 2 });
    expect(heading.textContent).toContain('personal Brain');
    await waitFor(() => {
      expect(screen.getByTestId('brain-summary').textContent).toBe('2 notes');
    });
    // Selector to the right of the name, in the same header row.
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
    // The band the stats live in is hidden during setup. If the switcher were
    // hidden with it, an account whose vault is unconfigured would strand the
    // user there with no way to switch away.
    vi.mocked(api.brainStatus).mockResolvedValue(status({ configured: false }));
    render(<BrainTab />);
    await screen.findByTestId('vault-setup');
    expect(screen.getByTestId('account-select')).toBeTruthy();
    expect(screen.queryByTestId('stats')).toBeNull();
  });
});
