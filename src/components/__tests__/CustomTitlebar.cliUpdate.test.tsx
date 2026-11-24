// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import type { CliReviewStatus, CliUpdateResult } from '@/lib/api';

// Animation wrappers render as plain DOM so assertions are synchronous.
vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: (_, key) => {
        const Tag = key as string;
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock factory hoisted before module imports settle.
        const React = require('react');
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
const updateClaudeCli = vi.fn<() => Promise<CliUpdateResult>>();
const checkForUpdate = vi.fn<() => Promise<unknown>>();

vi.mock('@/lib/api', () => ({
  CLI_RELEASE_NOTICE_ID_PREFIX: 'claude-cli-update:',
  api: {
    getAppVersion: () => Promise.resolve('0.4.152'),
    checkForUpdate: () => checkForUpdate(),
    getClaudeCliReviewStatus: () => getClaudeCliReviewStatus(),
    updateClaudeCli: () => updateClaudeCli(),
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
  updateClaudeCli.mockReset();
  checkForUpdate.mockReset();
  checkForUpdate.mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const openUpdates = () => {
  fireEvent.click(document.querySelector<HTMLButtonElement>('[data-updates-trigger]')!);
};

// Both waits must outlast MIN_CHECK_SPIN_MS.
async function renderSettled() {
  const result = render(<CustomTitlebar />);
  await vi.advanceTimersByTimeAsync(1000);
  openUpdates();
  await vi.advanceTimersByTimeAsync(1000);
  return result;
}

const updateButton = () =>
  document.querySelector<HTMLButtonElement>('[data-cli-update-run]');

const status = (over: Partial<CliReviewStatus> = {}): CliReviewStatus => ({
  installed_version: '2.1.252',
  reviewed_version: '2.1.252',
  checked_version: '2.1.252',
  unreviewed: false,
  latest_version: '2.1.257',
  upgrade_available: true,
  repo_dir: null,
  ...over,
});

describe('CustomTitlebar — forced Claude CLI update', () => {
  it('offers the update button when a newer release has been published', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(status());
    await renderSettled();

    await waitFor(() => { expect(updateButton()).not.toBeNull(); });
  });

  it('hides the button when the CLI is already current', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(
      status({ latest_version: '2.1.252', upgrade_available: false }),
    );
    await renderSettled();

    await waitFor(() => { expect(screen.queryAllByText('2.1.252').length).toBeGreaterThan(0); });
    expect(updateButton()).toBeNull();
  });

  it('hides the button when the registry could not be reached', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(
      status({ latest_version: null, upgrade_available: false }),
    );
    await renderSettled();

    await waitFor(() => { expect(screen.queryAllByText('2.1.252').length).toBeGreaterThan(0); });
    expect(updateButton()).toBeNull();
  });

  it('runs the update and re-reads the status so the row shows the new version', async () => {
    getClaudeCliReviewStatus.mockResolvedValueOnce(status());
    getClaudeCliReviewStatus.mockResolvedValueOnce(status());
    updateClaudeCli.mockResolvedValue({
      from: '2.1.252',
      to: '2.1.257',
      upgraded: true,
      accounts: [{ account: 'Personal', ok: true, message: 'ok' }],
    });
    getClaudeCliReviewStatus.mockResolvedValue(
      status({
        installed_version: '2.1.257',
        latest_version: '2.1.257',
        upgrade_available: false,
      }),
    );

    await renderSettled();
    await waitFor(() => { expect(updateButton()).not.toBeNull(); });
    fireEvent.click(updateButton()!);
    await vi.advanceTimersByTimeAsync(1000);

    expect(updateClaudeCli).toHaveBeenCalledTimes(1);
    await waitFor(() => { expect(updateButton()).toBeNull(); });
    expect(screen.queryAllByText('2.1.257').length).toBeGreaterThan(0);
  });

  it('surfaces a failure in the popover instead of silently doing nothing', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(status());
    updateClaudeCli.mockRejectedValue(new Error("npm global folder isn't writable"));

    await renderSettled();
    await waitFor(() => { expect(updateButton()).not.toBeNull(); });
    fireEvent.click(updateButton()!);
    await vi.advanceTimersByTimeAsync(1000);

    await waitFor(() => {
      expect(screen.queryAllByText(/isn't writable/).length).toBeGreaterThan(0);
    });
  });

  it('reports a run that changed nothing rather than claiming success', async () => {
    // `claude update` exits 0 both when current and when a policy pin blocks the
    // upgrade; only the re-probe tells them apart.
    getClaudeCliReviewStatus.mockResolvedValue(status());
    updateClaudeCli.mockResolvedValue({
      from: '2.1.252',
      to: '2.1.252',
      upgraded: false,
      accounts: [{ account: 'Personal', ok: true, message: 'up to date' }],
    });

    await renderSettled();
    await waitFor(() => { expect(updateButton()).not.toBeNull(); });
    fireEvent.click(updateButton()!);
    await vi.advanceTimersByTimeAsync(1000);

    await waitFor(() => {
      expect(screen.queryAllByText(/No change/i).length).toBeGreaterThan(0);
    });
  });

  it('disables the button while the update is running', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(status());
    let release!: (r: CliUpdateResult) => void;
    updateClaudeCli.mockReturnValue(new Promise<CliUpdateResult>((r) => { release = r; }));

    await renderSettled();
    await waitFor(() => { expect(updateButton()).not.toBeNull(); });
    fireEvent.click(updateButton()!);
    await vi.advanceTimersByTimeAsync(50);

    expect(updateButton()!.disabled).toBe(true);
    // Concurrent `claude update`s contend on .update.lock and the loser silently
    // does nothing.
    fireEvent.click(updateButton()!);
    expect(updateClaudeCli).toHaveBeenCalledTimes(1);

    release({ from: '2.1.252', to: '2.1.257', upgraded: true, accounts: [] });
    await vi.advanceTimersByTimeAsync(1000);
  });
});
