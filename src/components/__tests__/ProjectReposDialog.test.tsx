// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getProjectRepos: vi.fn(),
  setProjectRepoWatched: vi.fn(),
  setProjectRepoScanDepth: vi.fn(),
  removeProjectRepo: vi.fn(),
  onProjectReposChanged: vi.fn(() => () => {}),
  listBranchColors: vi.fn(async () => []),
  listGitBranches: vi.fn(async () => ['main']),
  upsertBranchColor: vi.fn(),
  deleteBranchColor: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api }));

import { ProjectReposDialog } from '../ProjectReposDialog';

const repos = {
  scanDepth: 1,
  rootIsRepo: true,
  rootPath: '/p',
  truncated: false,
  repos: [
    { path: '/p/api', name: 'api', watched: true, missing: false },
    { path: '/p/web', name: 'web', watched: false, missing: false },
    { path: '/p/gone', name: 'gone', watched: true, missing: true },
  ],
};

beforeEach(() => {
  for (const f of Object.values(api)) f.mockClear();
  api.getProjectRepos.mockResolvedValue(repos);
});
afterEach(() => { cleanup(); });

function open() {
  render(<ProjectReposDialog projectPath="/p" open onOpenChange={() => {}} />);
}

describe('ProjectReposDialog', () => {
  it('lists the project folder first with its watch locked on', async () => {
    open();
    const root = await screen.findByRole('switch', { name: /watch p$/i });
    expect(root.getAttribute('aria-checked')).toBe('true');
    expect((root as HTMLButtonElement).disabled).toBe(true);
  });

  it('turns watching on for a repo', async () => {
    open();
    fireEvent.click(await screen.findByRole('switch', { name: /watch web/i }));
    await waitFor(() => { expect(api.setProjectRepoWatched).toHaveBeenCalledWith('/p', '/p/web', true); });
  });

  it('changes the scan depth and rescans', async () => {
    open();
    fireEvent.change(await screen.findByLabelText(/scan depth/i), { target: { value: '3' } });
    await waitFor(() => { expect(api.setProjectRepoScanDepth).toHaveBeenCalledWith('/p', 3); });
    await waitFor(() => { expect(api.getProjectRepos).toHaveBeenCalledTimes(2); });
  });

  it('marks a missing repo and offers to remove it', async () => {
    open();
    expect(await screen.findByText(/missing/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /remove gone/i }));
    await waitFor(() => { expect(api.removeProjectRepo).toHaveBeenCalledWith('/p', '/p/gone'); });
  });

  it('shows a repo\'s branch colours when expanded', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: /branch colours for api/i }));
    await waitFor(() => { expect(api.listBranchColors).toHaveBeenCalledWith('/p/api'); });
  });

  it('warns when discovery was cut short', async () => {
    api.getProjectRepos.mockResolvedValue({ ...repos, truncated: true });
    open();
    expect(await screen.findByText(/showing the first 50 repos/i)).toBeTruthy();
  });

  it('puts the path on its own line under the full, untruncated name', async () => {
    open();
    const name = await screen.findByText('api');
    expect(name.className).not.toContain('truncate');
    const path = screen.getByText('/p/api');
    expect(path.className).not.toContain('truncate');
    // Separate lines: the path is not inside the name's line.
    expect(name.parentElement!.contains(path)).toBe(false);
    expect(name.closest('[data-repo-row-text]')!.contains(path)).toBe(true);
  });

  it('shortens the home folder in the path to ~', async () => {
    api.getProjectRepos.mockResolvedValue({
      ...repos,
      repos: [{ path: '/Users/someone/Repos/x', name: 'x', watched: false, missing: false }],
    });
    open();
    expect(await screen.findByText('~/Repos/x')).toBeTruthy();
  });
});
