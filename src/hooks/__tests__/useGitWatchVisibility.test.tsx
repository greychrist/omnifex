// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

const api = vi.hoisted(() => ({ setSessionGitWatchVisible: vi.fn() }));
vi.mock('@/lib/api', () => ({ api }));

import { useGitWatchVisibility } from '../useGitWatchVisibility';
import { POWER_STATE_CHANNEL } from '@/lib/powerState';

let power: ((p: unknown) => void) | null = null;
let hidden = false;
beforeEach(() => {
  power = null;
  hidden = false;
  api.setSessionGitWatchVisible.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    onEvent: vi.fn((ch: string, cb: (p: unknown) => void) => { if (ch === POWER_STATE_CHANNEL) power = cb; return () => {}; }),
  };
});
afterEach(cleanup);

const calls = () => api.setSessionGitWatchVisible.mock.calls;
const setHidden = (h: boolean) => { hidden = h; document.dispatchEvent(new Event('visibilitychange')); };

describe('useGitWatchVisibility', () => {
  it('tells the daemon a watch is visible only on the active tab of a visible, awake window', () => {
    const { rerender } = renderHook(({ active }) => { useGitWatchVisibility('w1', active); }, { initialProps: { active: true } });
    expect(calls().at(-1)).toEqual(['w1', true]);
    rerender({ active: false });
    expect(calls().at(-1)).toEqual(['w1', false]);
    rerender({ active: true });
    act(() => { setHidden(true); });
    expect(calls().at(-1)).toEqual(['w1', false]);
    act(() => { setHidden(false); });
    expect(calls().at(-1)).toEqual(['w1', true]);
    act(() => { power?.({ awake: false }); });
    expect(calls().at(-1)).toEqual(['w1', false]);
    act(() => { power?.({ awake: true }); });
    expect(calls().at(-1)).toEqual(['w1', true]);
  });

  it('reports each change once, and nothing without a watch', () => {
    const { rerender } = renderHook(({ id }) => { useGitWatchVisibility(id, true); }, { initialProps: { id: null as string | null } });
    expect(calls()).toEqual([]);
    rerender({ id: 'w1' });
    rerender({ id: 'w1' });
    expect(calls()).toEqual([['w1', true]]);
  });
});
