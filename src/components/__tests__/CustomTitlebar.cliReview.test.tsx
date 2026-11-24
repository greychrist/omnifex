// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import type { CliReviewStatus } from '@/lib/api';

// Animation wrappers render as plain DOM so assertions are synchronous.
vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: (_, key) => {
        const Tag = key as string;
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock factory hoisted before module imports settle.
        const React = require('react');
        // forwardRef, not a bare function: several of these are used as a
        // `asChild`-style trigger and are handed a ref.
        return React.forwardRef(({ children, ...rest }: any, ref: unknown) => {
          const { initial: _initial, animate: _animate, exit: _exit, transition: _transition, layout: _layout, whileTap: _whileTap, ...domProps } = rest;
          return React.createElement(Tag, { ...domProps, ref }, children);
        });
      },
    },
  ),
  AnimatePresence: ({ children }: any) => children,
}));

vi.mock('@/components/TabStatusPopover', () => ({
  TabStatusPopover: () => null,
}));

const getClaudeCliReviewStatus = vi.fn<() => Promise<CliReviewStatus | null>>();
const saveSetting = vi.fn<(key: string, value: string) => Promise<void>>();
const checkForUpdate = vi.fn<() => Promise<unknown>>();

vi.mock('@/lib/api', () => ({
  CLI_RELEASE_NOTICE_ID_PREFIX: 'claude-cli-update:',
  CLI_CHECKED_VERSION_SETTING_KEY: 'claude_cli_checked_version',
  api: {
    getAppVersion: () => Promise.resolve('0.4.109'),
    checkForUpdate: () => checkForUpdate(),
    getClaudeCliReviewStatus: () => getClaudeCliReviewStatus(),
    saveSetting: (key: string, value: string) => saveSetting(key, value),
    onSessionInFlightCount: () => () => {},
    onUpdateProgress: () => () => {},
    notifyClaudeCliRelease: () => Promise.resolve(false),
    onNotificationClicked: () => () => {},
    onInstallStatus: () => () => {},
    brainActiveRun: () => Promise.resolve(null),
    onBrainRunProgress: () => () => {},
  },
}));

import { CustomTitlebar } from '@/components/CustomTitlebar';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  getClaudeCliReviewStatus.mockReset();
  saveSetting.mockReset();
  saveSetting.mockResolvedValue(undefined);
  checkForUpdate.mockReset();
  checkForUpdate.mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

// Selected by attribute: the popover's header also reads "Updates".
const updatesButton = () =>
  document.querySelector<HTMLButtonElement>('[data-updates-trigger]')!;
const openUpdates = () => { fireEvent.click(updatesButton()); };

// The popover mounts its content only while open, and both waits must clear
// MIN_CHECK_SPIN_MS (700): one check on mount, one on opening.
async function renderSettled() {
  const result = render(<CustomTitlebar />);
  await vi.advanceTimersByTimeAsync(1000);
  openUpdates();
  await vi.advanceTimersByTimeAsync(1000);
  return result;
}

const unreviewedIcon = () => document.querySelector('[data-updates-unreviewed]');
const upgradeLit = () => {
  const icon = document.querySelector('[data-updates-icon]');
  return !!icon && icon.getAttribute('data-upgrade') === 'true'
    && (icon.getAttribute('class') ?? '').includes('text-emerald-500');
};
const seen = (text: string | RegExp) => screen.queryAllByText(text).length;

describe('CustomTitlebar — Claude Code changelog watermark', () => {
  it('badges the Updates button when the installed CLI is ahead of the watermark', async () => {
    getClaudeCliReviewStatus.mockResolvedValue({
      installed_version: '2.1.230',
      reviewed_version: '2.1.222',
      checked_version: '2.1.222',
      unreviewed: true,
      latest_version: null,
      upgrade_available: false,
      repo_dir: null,
    });
    await renderSettled();

    await waitFor(() => { expect(unreviewedIcon()).not.toBeNull(); });
    expect(upgradeLit()).toBe(false);
    expect(seen(/ahead of the 2\.1\.222 changelog/)).toBeGreaterThan(0);
    expect(seen('2.1.230')).toBeGreaterThan(0);
  });

  it('shows no badge when the CLI matches the watermark', async () => {
    getClaudeCliReviewStatus.mockResolvedValue({
      installed_version: '2.1.222',
      reviewed_version: '2.1.222',
      checked_version: '2.1.222',
      unreviewed: false,
      latest_version: null,
      upgrade_available: false,
      repo_dir: null,
    });
    await renderSettled();

    await waitFor(() => { expect(seen('2.1.222')).toBeGreaterThan(0); });
    expect(unreviewedIcon()).toBeNull();
    expect(upgradeLit()).toBe(false);
    expect(seen(/ahead of the/)).toBe(0);
  });

  it('reports "not found" rather than badging when no CLI is installed', async () => {
    getClaudeCliReviewStatus.mockResolvedValue({
      installed_version: null,
      reviewed_version: '2.1.222',
      checked_version: '2.1.222',
      unreviewed: false,
      latest_version: null,
      upgrade_available: false,
      repo_dir: null,
    });
    await renderSettled();

    await waitFor(() => { expect(seen('not found')).toBeGreaterThan(0); });
    expect(unreviewedIcon()).toBeNull();
  });

  // The CLI self-updates only when launched directly, never from OmniFex's
  // spawns.
  it('offers the newer published release next to the installed one', async () => {
    getClaudeCliReviewStatus.mockResolvedValue({
      installed_version: '2.1.241',
      reviewed_version: '2.1.241',
      checked_version: '2.1.241',
      unreviewed: false,
      latest_version: '2.1.246',
      upgrade_available: true,
      repo_dir: null,
    });
    await renderSettled();

    await waitFor(() => { expect(seen(/2\.1\.241/)).toBeGreaterThan(0); });
    expect(seen(/2\.1\.246 available/)).toBeGreaterThan(0);
  });

  it('shows the bare installed version when it is already current', async () => {
    getClaudeCliReviewStatus.mockResolvedValue({
      installed_version: '2.1.246',
      reviewed_version: '2.1.241',
      checked_version: '2.1.241',
      unreviewed: true,
      latest_version: '2.1.246',
      upgrade_available: false,
      repo_dir: null,
    });
    await renderSettled();

    await waitFor(() => { expect(seen('2.1.246')).toBeGreaterThan(0); });
    expect(seen(/available/)).toBe(0);
  });

  it('says nothing about upgrades when the registry was unreachable', async () => {
    getClaudeCliReviewStatus.mockResolvedValue({
      installed_version: '2.1.241',
      reviewed_version: '2.1.241',
      checked_version: '2.1.241',
      unreviewed: false,
      latest_version: null,
      upgrade_available: false,
      repo_dir: null,
    });
    await renderSettled();

    await waitFor(() => { expect(seen('2.1.241')).toBeGreaterThan(0); });
    expect(seen(/available/)).toBe(0);
  });

  it('badges the button for an upgrade the user has not installed', async () => {
    getClaudeCliReviewStatus.mockResolvedValue({
      installed_version: '2.1.241',
      reviewed_version: '2.1.241',
      checked_version: '2.1.241',
      unreviewed: false,
      latest_version: '2.1.246',
      upgrade_available: true,
      repo_dir: '/repo',
    });
    await renderSettled();

    await waitFor(() => { expect(seen(/2\.1\.246 available/)).toBeGreaterThan(0); });
    expect(upgradeLit()).toBe(true);
    expect(unreviewedIcon()).toBeNull();
    expect(seen(/ahead of the/)).toBe(0);
  });

  it('stays silent when the status call fails', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(null);
    await renderSettled();

    expect(upgradeLit()).toBe(false);
    expect(unreviewedIcon()).toBeNull();
    expect(seen('Claude Code')).toBe(0);
    expect(seen('OmniFex 0.4.109')).toBeGreaterThan(0);
  });
});

describe('CustomTitlebar — launching the changelog review', () => {
  const drifted = (repo_dir: string | null): CliReviewStatus => ({
    installed_version: '2.1.224',
    reviewed_version: '2.1.222',
    checked_version: '2.1.222',
    unreviewed: true,
    latest_version: null,
    upgrade_available: false,
    repo_dir,
  });

  const launchButtons = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[data-cli-review-launch]'));

  it('makes the drift warning clickable when a repo is resolved', async () => {
    const onCliReviewClick = vi.fn();
    getClaudeCliReviewStatus.mockResolvedValue(drifted('/repos/omnifex'));
    render(<CustomTitlebar onCliReviewClick={onCliReviewClick} />);
    await vi.advanceTimersByTimeAsync(1000);
    openUpdates();
    await vi.advanceTimersByTimeAsync(300);

    await waitFor(() => { expect(launchButtons().length).toBeGreaterThan(0); });
    fireEvent.click(launchButtons()[0]);
    expect(onCliReviewClick).toHaveBeenCalledWith({
      repoDir: '/repos/omnifex',
      reviewedVersion: '2.1.222',
      installedVersion: '2.1.224',
    });
  });

  it('stays plain text when no OmniFex checkout could be found', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(drifted(null));
    await renderSettled();

    await waitFor(() => { expect(seen(/ahead of the 2\.1\.222 changelog/)).toBeGreaterThan(0); });
    expect(launchButtons()).toHaveLength(0);
    expect(seen(/Settings → General/)).toBeGreaterThan(0);
  });

  it('stays plain text when the host provides no launch handler', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(drifted('/repos/omnifex'));
    await renderSettled();

    await waitFor(() => { expect(seen(/ahead of the 2\.1\.222 changelog/)).toBeGreaterThan(0); });
    expect(launchButtons()).toHaveLength(0);
  });

  it('offers no launch when the CLI has not drifted', async () => {
    getClaudeCliReviewStatus.mockResolvedValue({
      installed_version: '2.1.222',
      reviewed_version: '2.1.222',
      checked_version: '2.1.222',
      unreviewed: false,
      latest_version: null,
      upgrade_available: false,
      repo_dir: '/repos/omnifex',
    });
    render(<CustomTitlebar onCliReviewClick={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(1000);
    openUpdates();
    await vi.advanceTimersByTimeAsync(300);

    await waitFor(() => { expect(seen('2.1.222')).toBeGreaterThan(0); });
    expect(launchButtons()).toHaveLength(0);
  });
});

describe('CustomTitlebar — Updates disclosure', () => {
  const clean: CliReviewStatus = {
    installed_version: '2.1.246',
    reviewed_version: '2.1.246',
    checked_version: '2.1.246',
    unreviewed: false,
    latest_version: '2.1.246',
    upgrade_available: false,
    repo_dir: null,
  };

  it('checks every time the popover opens, including right after launch', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(clean);
    render(<CustomTitlebar />);
    await vi.advanceTimersByTimeAsync(1000);

    const beforeApp = checkForUpdate.mock.calls.length;
    const beforeCli = getClaudeCliReviewStatus.mock.calls.length;

    openUpdates();
    await vi.advanceTimersByTimeAsync(1000);

    expect(checkForUpdate.mock.calls.length).toBe(beforeApp + 1);
    expect(getClaudeCliReviewStatus.mock.calls.length).toBe(beforeCli + 1);
  });

  it('checks again on a second open, with no time-based suppression', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(clean);
    await renderSettled();

    const afterFirst = checkForUpdate.mock.calls.length;

    openUpdates();                      // close
    await vi.advanceTimersByTimeAsync(50);
    openUpdates();                      // open again, immediately
    await vi.advanceTimersByTimeAsync(1000);

    expect(checkForUpdate.mock.calls.length).toBe(afterFirst + 1);
  });

  it('fires once per open, not once per render while open', async () => {
    // Keyed on the open EVENT, not the flag: checking -> up-to-date -> idle would
    // otherwise re-fire it forever.
    getClaudeCliReviewStatus.mockResolvedValue(clean);
    await renderSettled();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(checkForUpdate.mock.calls.length).toBe(2); // mount + one open
  });

  it('does not check when the popover closes', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(clean);
    await renderSettled();

    const afterOpen = checkForUpdate.mock.calls.length;
    openUpdates();                      // close
    await vi.advanceTimersByTimeAsync(1000);

    expect(checkForUpdate.mock.calls.length).toBe(afterOpen);
  });

  it('does not stack a second check onto one already in flight', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(clean);
    render(<CustomTitlebar />);
    openUpdates();
    await vi.advanceTimersByTimeAsync(2000);

    expect(checkForUpdate.mock.calls.length).toBe(1);
  });

  it('re-checks both from the refresh icon by the title, popover still open', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(clean);
    await renderSettled();
    const refresh = document.querySelector<HTMLButtonElement>('[data-updates-refresh]');
    expect(refresh).not.toBeNull();
    const cli = getClaudeCliReviewStatus.mock.calls.length;
    const app = checkForUpdate.mock.calls.length;
    fireEvent.click(refresh!);
    await vi.advanceTimersByTimeAsync(1000);
    expect(getClaudeCliReviewStatus.mock.calls.length).toBe(cli + 1);
    expect(checkForUpdate.mock.calls.length).toBe(app + 1);
    expect(seen('Claude Code')).toBeGreaterThan(0);
  });

  it('spins and stands down while a check is already running', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(clean);
    await renderSettled();
    // Re-queried each time: the popover re-renders its content.
    const refresh = () => document.querySelector<HTMLButtonElement>('[data-updates-refresh]')!;
    fireEvent.click(refresh());
    expect(refresh().disabled).toBe(true);
    expect(refresh().querySelector('svg')?.getAttribute('class')).toMatch(/animate-spin/);
    const cli = getClaudeCliReviewStatus.mock.calls.length;
    fireEvent.click(refresh());
    expect(getClaudeCliReviewStatus.mock.calls.length).toBe(cli);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh().disabled).toBe(false);
  });

  it('badges independently for a drifted watermark and for a published upgrade', async () => {
    getClaudeCliReviewStatus.mockResolvedValue({
      ...clean, unreviewed: true, reviewed_version: '2.1.241', checked_version: '2.1.241',
    });
    await renderSettled();
    await waitFor(() => { expect(unreviewedIcon()).not.toBeNull(); });
    expect(upgradeLit()).toBe(false);

    cleanup();
    getClaudeCliReviewStatus.mockResolvedValue({
      ...clean, latest_version: '2.1.250', upgrade_available: true,
    });
    await renderSettled();
    await waitFor(() => { expect(upgradeLit()).toBe(true); });
    expect(unreviewedIcon()).toBeNull();
  });

  it('shows neither signal when nothing is waiting', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(clean);
    await renderSettled();

    await waitFor(() => { expect(seen('Claude Code')).toBeGreaterThan(0); });
    expect(upgradeLit()).toBe(false);
    expect(unreviewedIcon()).toBeNull();
  });
});

describe('CustomTitlebar — marking a CLI release as checked', () => {
  const drifted: CliReviewStatus = {
    installed_version: '2.1.290',
    reviewed_version: '2.1.289',
    checked_version: '2.1.289',
    unreviewed: true,
    latest_version: null,
    upgrade_available: false,
    repo_dir: '/repos/omnifex',
  };
  const markButton = () =>
    document.querySelector<HTMLButtonElement>('[data-cli-review-mark]');
  const pendingRelease = () =>
    document.querySelector('[data-cli-review-pending-release]');

  it('offers to mark the installed release checked while it is drifted', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(drifted);
    await renderSettled();

    await waitFor(() => { expect(markButton()).not.toBeNull(); });
    expect(markButton()!.textContent).toMatch(/Mark 2\.1\.290 as checked/);
  });

  it('stores the installed version and re-reads the status', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(drifted);
    await renderSettled();
    await waitFor(() => { expect(markButton()).not.toBeNull(); });

    getClaudeCliReviewStatus.mockResolvedValue({
      ...drifted, checked_version: '2.1.290', unreviewed: false,
    });
    const before = getClaudeCliReviewStatus.mock.calls.length;
    fireEvent.click(markButton()!);

    await waitFor(() => {
      expect(saveSetting).toHaveBeenCalledWith('claude_cli_checked_version', '2.1.290');
    });
    await waitFor(() => {
      expect(getClaudeCliReviewStatus.mock.calls.length).toBeGreaterThan(before);
    });
    await waitFor(() => { expect(unreviewedIcon()).toBeNull(); });
    expect(markButton()).toBeNull();
  });

  it('offers nothing to mark when the CLI has not drifted', async () => {
    getClaudeCliReviewStatus.mockResolvedValue({
      ...drifted, installed_version: '2.1.289', unreviewed: false,
    });
    await renderSettled();
    await waitFor(() => { expect(seen('2.1.289')).toBeGreaterThan(0); });
    expect(markButton()).toBeNull();
  });

  it('says when a checked release has not shipped in a build yet', async () => {
    getClaudeCliReviewStatus.mockResolvedValue({
      ...drifted, checked_version: '2.1.290', unreviewed: false,
    });
    await renderSettled();

    await waitFor(() => { expect(pendingRelease()).not.toBeNull(); });
    expect(pendingRelease()!.textContent).toBe('2.1.290 checked and verified');
    const check = pendingRelease()!.querySelector('[data-cli-review-checked-icon]');
    expect(check).not.toBeNull();
    expect(check!.getAttribute('class')).toMatch(/text-emerald-500/);
    expect(unreviewedIcon()).toBeNull();
  });

  it('says nothing extra when the build carries the checked release', async () => {
    getClaudeCliReviewStatus.mockResolvedValue({
      ...drifted, installed_version: '2.1.289', unreviewed: false,
    });
    await renderSettled();
    await waitFor(() => { expect(seen('2.1.289')).toBeGreaterThan(0); });
    expect(pendingRelease()).toBeNull();
  });

  it('starts the next review from the checked release, not the built-in one', async () => {
    const onCliReviewClick = vi.fn();
    getClaudeCliReviewStatus.mockResolvedValue({
      ...drifted, installed_version: '2.1.291', checked_version: '2.1.290',
    });
    render(<CustomTitlebar onCliReviewClick={onCliReviewClick} />);
    await vi.advanceTimersByTimeAsync(1000);
    openUpdates();
    await vi.advanceTimersByTimeAsync(1000);

    const launch = () => document.querySelector<HTMLButtonElement>('[data-cli-review-launch]');
    await waitFor(() => { expect(launch()).not.toBeNull(); });
    expect(seen(/ahead of the 2\.1\.290 changelog/)).toBeGreaterThan(0);
    fireEvent.click(launch()!);
    expect(onCliReviewClick).toHaveBeenCalledWith({
      repoDir: '/repos/omnifex',
      reviewedVersion: '2.1.290',
      installedVersion: '2.1.291',
    });
  });
});
