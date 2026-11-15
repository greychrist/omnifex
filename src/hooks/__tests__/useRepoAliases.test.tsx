// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const { listRepoAliases, onRepoAliasesChanged } = vi.hoisted(() => ({
  listRepoAliases: vi.fn(),
  onRepoAliasesChanged: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api: { listRepoAliases, onRepoAliasesChanged } }));

import { useRepoAliases } from '../useRepoAliases';

let fire: () => void = () => {};

beforeEach(() => {
  listRepoAliases.mockReset().mockResolvedValue({ '/a': 'backend' });
  onRepoAliasesChanged.mockReset().mockImplementation((cb: () => void) => { fire = cb; return () => {}; });
});

describe('useRepoAliases', () => {
  it('loads aliases for the repos asked for', async () => {
    const { result } = renderHook(() => useRepoAliases(['/a', '/b']));
    await waitFor(() => { expect(result.current).toEqual({ '/a': 'backend' }); });
    expect(listRepoAliases).toHaveBeenCalledWith(['/a', '/b']);
  });

  it('reloads when any alias changes', async () => {
    const { result } = renderHook(() => useRepoAliases(['/a']));
    await waitFor(() => { expect(result.current['/a']).toBe('backend'); });
    listRepoAliases.mockResolvedValue({ '/a': 'api' });
    act(() => { fire(); });
    await waitFor(() => { expect(result.current['/a']).toBe('api'); });
  });

  it('asks for nothing with no repos', () => {
    renderHook(() => useRepoAliases([]));
    expect(listRepoAliases).not.toHaveBeenCalled();
  });
});
