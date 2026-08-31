// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { useBrainVault } from '../useBrainVault';
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

function status(over: Partial<BrainVaultStatus> = {}): BrainVaultStatus {
  return {
    accountId: 1, configured: true, path: '/v', exists: true, initialized: true,
    noteCount: 2, indexedCount: 2, gitAvailable: true, lastGitError: null,
    conflict: null, ...over,
  };
}

/** A listing row. This hook only ever passes them through. */
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

describe('useBrainVault', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    // Echo the requested account back, so a test can tell WHOSE status landed.
    vi.mocked(api.brainStatus).mockImplementation((id) => Promise.resolve(status({ accountId: id })));
    vi.mocked(api.brainListNoteMeta).mockResolvedValue([noteMeta('Notes/A.md'), noteMeta('Notes/B.md')]);
    vi.mocked(api.brainRebuild).mockResolvedValue(2);
    vi.mocked(api.brainSetVaultPath).mockResolvedValue(undefined);
    vi.mocked(api.brainClearVaultPath).mockResolvedValue(undefined);
  });

  it('loads status and notes for the selected account', async () => {
    const { result } = renderHook(() => useBrainVault());
    act(() => { result.current.setAccountId(1); });

    await waitFor(() => { expect(result.current.notes).toHaveLength(2); });
    expect(result.current.status?.configured).toBe(true);
  });

  it('clears notes when the account changes, before the new load resolves', async () => {
    const { result } = renderHook(() => useBrainVault());
    act(() => { result.current.setAccountId(1); });
    await waitFor(() => { expect(result.current.notes).toHaveLength(2); });

    let resolveSecond: (v: BrainNoteMeta[]) => void = () => {};
    vi.mocked(api.brainListNoteMeta).mockReturnValueOnce(
      new Promise<BrainNoteMeta[]>((r) => { resolveSecond = r; }),
    );

    act(() => { result.current.setAccountId(2); });
    // Account 1's notes must not be visible for even one frame under account 2.
    expect(result.current.notes).toEqual([]);

    await act(async () => { resolveSecond([noteMeta('Notes/C.md')]); });
    await waitFor(() => {
      expect(result.current.notes.map((n) => n.relPath)).toEqual(['Notes/C.md']);
    });
  });

  it('discards a slow load for a previous account', async () => {
    let resolveFirst: (v: BrainVaultStatus) => void = () => {};
    vi.mocked(api.brainStatus).mockImplementationOnce(
      () => new Promise<BrainVaultStatus>((r) => { resolveFirst = r; }),
    );

    const { result } = renderHook(() => useBrainVault());
    act(() => { result.current.setAccountId(1); });
    act(() => { result.current.setAccountId(2); });
    await waitFor(() => { expect(result.current.status?.accountId).toBe(2); });

    // Account 1's response lands late. It must not overwrite account 2's.
    await act(async () => { resolveFirst(status({ accountId: 1, noteCount: 99 })); });
    expect(result.current.status?.accountId).toBe(2);
  });

  it('does not list notes for an unconfigured vault', async () => {
    vi.mocked(api.brainStatus).mockResolvedValue(
      status({ accountId: 1, configured: false, exists: false, path: null }),
    );
    const { result } = renderHook(() => useBrainVault());
    act(() => { result.current.setAccountId(1); });

    await waitFor(() => { expect(result.current.status?.configured).toBe(false); });
    expect(api.brainListNoteMeta).not.toHaveBeenCalled();
  });

  it('does not list notes for a configured vault whose directory is gone', async () => {
    vi.mocked(api.brainStatus).mockResolvedValue(status({ exists: false }));
    const { result } = renderHook(() => useBrainVault());
    act(() => { result.current.setAccountId(1); });

    await waitFor(() => { expect(result.current.status?.exists).toBe(false); });
    expect(api.brainListNoteMeta).not.toHaveBeenCalled();
  });

  it('surfaces a load failure instead of rendering an empty vault', async () => {
    vi.mocked(api.brainStatus).mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useBrainVault());
    act(() => { result.current.setAccountId(1); });

    await waitFor(() => { expect(result.current.error).toContain('boom'); });
    expect(result.current.status).toBeNull();
  });

  it('reloads after a rebuild', async () => {
    const { result } = renderHook(() => useBrainVault());
    act(() => { result.current.setAccountId(1); });
    await waitFor(() => { expect(result.current.notes).toHaveLength(2); });

    await act(async () => { await result.current.rebuild(); });
    expect(api.brainRebuild).toHaveBeenCalledWith(1);
    expect(api.brainStatus).toHaveBeenCalledTimes(2);
  });

  it('surfaces a setVaultPath rejection rather than swallowing it', async () => {
    vi.mocked(api.brainSetVaultPath).mockRejectedValue(new Error('overlaps another account'));
    const { result } = renderHook(() => useBrainVault());
    act(() => { result.current.setAccountId(1); });
    await waitFor(() => { expect(result.current.notes).toHaveLength(2); });

    await act(async () => { await result.current.setVaultPath('/somewhere'); });
    expect(result.current.error).toContain('overlaps');
  });

  it('does nothing before an account is selected', async () => {
    const { result } = renderHook(() => useBrainVault());
    await act(async () => { await result.current.rebuild(); });
    expect(api.brainStatus).not.toHaveBeenCalled();
    expect(api.brainRebuild).not.toHaveBeenCalled();
  });
});
