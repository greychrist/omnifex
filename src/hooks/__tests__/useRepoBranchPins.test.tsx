// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const { listBranchColors, onBranchColorsChanged } = vi.hoisted(() => ({
  listBranchColors: vi.fn(),
  onBranchColorsChanged: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api: { listBranchColors, onBranchColorsChanged } }));

import { useRepoBranchPins } from '../useRepoBranchPins';

let fire: (repoPath: string) => void = () => {};

beforeEach(() => {
  listBranchColors.mockReset().mockImplementation(async (p: string) =>
    p === '/a' ? [{ branch_name: 'feat', color: '#111111' }] : [],
  );
  onBranchColorsChanged.mockReset().mockImplementation((cb: (p: string) => void) => {
    fire = cb;
    return () => {};
  });
});

describe('useRepoBranchPins', () => {
  it('loads pins for each repo, keyed by the path asked for', async () => {
    const { result } = renderHook(() => useRepoBranchPins(['/a', '/b']));
    await waitFor(() => { expect(result.current).toEqual({ '/a': { feat: '#111111' }, '/b': {} }); });
  });

  it('reloads when any repo\'s pins change', async () => {
    const { result } = renderHook(() => useRepoBranchPins(['/a']));
    await waitFor(() => { expect(result.current['/a']).toBeDefined(); });
    listBranchColors.mockResolvedValue([{ branch_name: 'feat', color: '#222222' }]);
    act(() => { fire('/a'); });
    await waitFor(() => { expect(result.current['/a']).toEqual({ feat: '#222222' }); });
  });

  it('does not reload when re-rendered with the same repos', async () => {
    const { rerender } = renderHook(({ paths }) => useRepoBranchPins(paths), { initialProps: { paths: ['/a'] } });
    await waitFor(() => { expect(listBranchColors).toHaveBeenCalledTimes(1); });
    rerender({ paths: ['/a'] });
    await new Promise((r) => setTimeout(r, 20));
    expect(listBranchColors).toHaveBeenCalledTimes(1);
  });
});
