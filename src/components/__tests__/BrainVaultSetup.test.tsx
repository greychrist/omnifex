// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { BrainVaultSetup } from '@/components/brain/BrainVaultSetup';
import type { UseBrainVault } from '@/hooks/useBrainVault';
import { api, type BrainVaultStatus } from '@/lib/api';

vi.mock('@/lib/api', () => ({ api: { brainDefaultVaultPath: vi.fn() } }));

const SUGGESTED = '/Users/x/Documents/OmniFex Brain/personal';

function status(over: Partial<BrainVaultStatus> = {}): BrainVaultStatus {
  return {
    accountId: 1, configured: false, path: null, exists: false, initialized: false,
    noteCount: 0, indexedCount: null, gitAvailable: true, lastGitError: null,
    conflict: null, ...over,
  };
}

function makeVault(over: Partial<UseBrainVault> = {}): UseBrainVault {
  return {
    accountId: 1,
    setAccountId: vi.fn(),
    status: status(),
    notes: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    rebuild: vi.fn().mockResolvedValue(undefined),
    setVaultPath: vi.fn().mockResolvedValue(undefined),
    clearVaultPath: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe('BrainVaultSetup', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(api.brainDefaultVaultPath).mockResolvedValue(SUGGESTED);
  });

  it('prefills the suggested path for an unconfigured account', async () => {
    render(<BrainVaultSetup vault={makeVault()} accountName="personal" />);
    await waitFor(() => {
      expect(screen.getByRole('textbox')).toHaveProperty('value', SUGGESTED);
    });
  });

  it('submits the path the user actually typed, not the suggestion', async () => {
    const setVaultPath = vi.fn().mockResolvedValue(undefined);
    render(<BrainVaultSetup vault={makeVault({ setVaultPath })} accountName="personal" />);
    const input = await screen.findByRole('textbox');

    fireEvent.change(input, { target: { value: '/tmp/mine' } });
    fireEvent.click(screen.getByRole('button', { name: /create vault/i }));

    expect(setVaultPath).toHaveBeenCalledWith('/tmp/mine');
  });

  it('does not submit an empty path', async () => {
    const setVaultPath = vi.fn();
    render(<BrainVaultSetup vault={makeVault({ setVaultPath })} accountName="personal" />);
    const input = await screen.findByRole('textbox');

    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /create vault/i }));

    expect(setVaultPath).not.toHaveBeenCalled();
  });

  it('reports a configured vault whose directory is gone', () => {
    const vault = makeVault({ status: status({ configured: true, path: '/gone', exists: false }) });
    render(<BrainVaultSetup vault={vault} accountName="personal" />);
    expect(screen.getByText(/no longer exists/i)).toBeTruthy();
  });

  it('offers to recreate a missing vault at its configured path', () => {
    const setVaultPath = vi.fn().mockResolvedValue(undefined);
    const vault = makeVault({
      setVaultPath,
      status: status({ configured: true, path: '/gone', exists: false }),
    });
    render(<BrainVaultSetup vault={vault} accountName="personal" />);

    fireEvent.click(screen.getByRole('button', { name: /recreate/i }));
    expect(setVaultPath).toHaveBeenCalledWith('/gone');
  });

  it('shows a conflict without offering any repair button', () => {
    const vault = makeVault({
      status: status({
        configured: true, path: '/v', exists: true,
        conflict: 'vault path overlaps one already assigned to another account: /v',
      }),
    });
    render(<BrainVaultSetup vault={vault} accountName="personal" />);

    expect(screen.getByText(/overlaps/)).toBeTruthy();
    // A conflict is fixed by choosing a DIFFERENT path, so a retry button
    // would only invite the user to hammer something that fails by design.
    expect(screen.queryByRole('button', { name: /rebuild/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /recreate/i })).toBeNull();
  });

  it('offers a rebuild when the index is behind the vault', () => {
    const rebuild = vi.fn().mockResolvedValue(undefined);
    const vault = makeVault({
      rebuild,
      status: status({
        configured: true, path: '/v', exists: true, initialized: true,
        noteCount: 12, indexedCount: 0,
      }),
    });
    render(<BrainVaultSetup vault={vault} accountName="personal" />);

    fireEvent.click(screen.getByRole('button', { name: /rebuild index/i }));
    expect(rebuild).toHaveBeenCalled();
  });

  it('mentions how many notes are unindexed', () => {
    const vault = makeVault({
      status: status({
        configured: true, path: '/v', exists: true, initialized: true,
        noteCount: 12, indexedCount: 0,
      }),
    });
    render(<BrainVaultSetup vault={vault} accountName="personal" />);
    expect(screen.getByText(/12/)).toBeTruthy();
  });

  it('surfaces a git failure so versioning status is never fiction', () => {
    const vault = makeVault({
      status: status({
        configured: true, path: '/v', exists: true, initialized: true,
        noteCount: 1, indexedCount: 1, lastGitError: 'fatal: unable to write',
      }),
    });
    render(<BrainVaultSetup vault={vault} accountName="personal" />);
    expect(screen.getByText(/unable to write/)).toBeTruthy();
  });

  it('warns when git is unavailable entirely', () => {
    const vault = makeVault({
      status: status({
        configured: true, path: '/v', exists: true, initialized: true,
        noteCount: 1, indexedCount: 1, gitAvailable: false,
      }),
    });
    render(<BrainVaultSetup vault={vault} accountName="personal" />);
    expect(screen.getByText(/versioning is disabled/i)).toBeTruthy();
  });

  it('can unconfigure a vault without deleting it', () => {
    const clearVaultPath = vi.fn().mockResolvedValue(undefined);
    const vault = makeVault({
      clearVaultPath,
      status: status({ configured: true, path: '/v', exists: true, initialized: true }),
    });
    render(<BrainVaultSetup vault={vault} accountName="personal" />);

    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    expect(clearVaultPath).toHaveBeenCalled();
  });

  it('renders without an account name rather than crashing', () => {
    render(<BrainVaultSetup vault={makeVault()} accountName={null} />);
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect(api.brainDefaultVaultPath).not.toHaveBeenCalled();
  });
});
