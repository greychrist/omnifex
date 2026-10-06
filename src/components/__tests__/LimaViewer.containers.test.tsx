// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';

// Container tiles are compact: start/stop live in the header beside the name,
// and image/status/ports are tight labelled rows rather than a grid of pills
// with a separate action bar — a VM with a dozen containers should fit
// without scrolling.

const api = vi.hoisted(() => ({
  limaCheckInstalled: vi.fn(),
  limaListVms: vi.fn(),
  limaListContainers: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api }));

import { LimaViewer } from '../LimaViewer';

beforeEach(() => {
  api.limaCheckInstalled.mockReset().mockResolvedValue({ installed: true });
  api.limaListVms.mockReset().mockResolvedValue([
    { name: 'default', status: 'Running', arch: 'aarch64', cpus: 4, memoryBytes: 1, diskBytes: 1, dir: '/x' },
  ]);
  api.limaListContainers.mockReset().mockResolvedValue([
    { id: 'c1', name: 'pituitive-proxy', image: 'pituitive-proxy:dev', state: 'running', status: 'Up 14 hours', ports: '0.0.0.0:4000->80/tcp' },
  ]);
  (window as unknown as { electronAPI: unknown }).electronAPI = { onEvent: vi.fn(() => () => {}) };
});
afterEach(cleanup);

describe('LimaViewer container tiles', () => {
  it('puts the start/stop controls in the header beside the container name', async () => {
    render(<LimaViewer isActive />);
    const name = await screen.findByText('pituitive-proxy');
    const header = name.closest('header');
    expect(header).not.toBeNull();
    expect(within(header!).getByTitle('Stop pituitive-proxy')).toBeTruthy();
    expect(within(header!).getByTitle('Already running')).toBeTruthy();
  });

  it('labels image, status and ports', async () => {
    render(<LimaViewer isActive />);
    const tile = (await screen.findByText('pituitive-proxy')).closest('li')!;
    await waitFor(() => expect(within(tile).getByText('pituitive-proxy:dev')).toBeTruthy());
    expect(within(tile).getByText('Up 14 hours')).toBeTruthy();
    expect(within(tile).getByText('0.0.0.0:4000->80/tcp')).toBeTruthy();
    for (const label of ['Image', 'Status', 'Ports']) expect(within(tile).getByText(label)).toBeTruthy();
  });
});
