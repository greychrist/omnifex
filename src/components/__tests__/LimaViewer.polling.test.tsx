// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';

// Every Lima poll is a `limactl` process in the daemon, and every OmniFex tab
// stays mounted. The viewer polls only while someone can see it: its tab is
// active, the document is visible, and the machine is awake — the same rule
// the git watcher follows (useSurfaceVisible).

const api = vi.hoisted(() => ({
  limaCheckInstalled: vi.fn(),
  limaListVms: vi.fn(),
  limaListContainers: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api }));

import { LimaViewer } from '../LimaViewer';
import { POWER_STATE_CHANNEL } from '@/lib/powerState';

let power: ((p: unknown) => void) | null = null;
let hidden = false;
const setHidden = (h: boolean) => { hidden = h; document.dispatchEvent(new Event('visibilitychange')); };

beforeEach(() => {
  vi.useFakeTimers();
  power = null;
  hidden = false;
  api.limaCheckInstalled.mockReset().mockResolvedValue({ installed: true });
  api.limaListVms.mockReset().mockResolvedValue([
    { name: 'default', status: 'Running', arch: 'aarch64', cpus: 4, memoryBytes: 1, diskBytes: 1, dir: '/x' },
  ]);
  api.limaListContainers.mockReset().mockResolvedValue([]);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    onEvent: vi.fn((ch: string, cb: (p: unknown) => void) => { if (ch === POWER_STATE_CHANNEL) power = cb; return () => {}; }),
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('LimaViewer polling', () => {
  it('does not touch limactl while its tab is inactive, and loads at once when it becomes active', async () => {
    const { rerender } = render(<LimaViewer isActive={false} />);
    await flush();
    await advance(60_000);
    expect(api.limaListVms).not.toHaveBeenCalled();
    expect(api.limaListContainers).not.toHaveBeenCalled();

    rerender(<LimaViewer isActive />);
    await flush();
    expect(api.limaListVms).toHaveBeenCalledTimes(1);
    expect(api.limaListContainers).toHaveBeenCalledTimes(1);
  });

  it('polls VMs every 5 s and containers every 15 s while visible', async () => {
    render(<LimaViewer isActive />);
    await flush();
    api.limaListVms.mockClear();
    api.limaListContainers.mockClear();
    await advance(15_000);
    expect(api.limaListVms).toHaveBeenCalledTimes(3);
    expect(api.limaListContainers).toHaveBeenCalledTimes(1);
  });

  it('stops both pollers while the document is hidden or the machine sleeps', async () => {
    render(<LimaViewer isActive />);
    await flush();

    act(() => { setHidden(true); });
    api.limaListVms.mockClear();
    api.limaListContainers.mockClear();
    await advance(60_000);
    expect(api.limaListVms).not.toHaveBeenCalled();
    expect(api.limaListContainers).not.toHaveBeenCalled();

    act(() => { setHidden(false); });
    await flush();
    expect(api.limaListVms).toHaveBeenCalledTimes(1);

    act(() => { power?.({ awake: false }); });
    api.limaListVms.mockClear();
    api.limaListContainers.mockClear();
    await advance(60_000);
    expect(api.limaListVms).not.toHaveBeenCalled();
    expect(api.limaListContainers).not.toHaveBeenCalled();
  });
});
