// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, act, fireEvent, waitFor } from '@testing-library/react';

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
          const { initial, animate, exit, transition, layout, whileTap, ...domProps } = rest;
          void initial; void animate; void exit; void transition; void layout; void whileTap;
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

const ZIP = '/tmp/omnifex-update/OmniFex-darwin-arm64-0.4.230.zip';
const checkForUpdate = vi.fn<() => Promise<unknown>>();
const downloadUpdate = vi.fn<(url: string, asset: string) => Promise<string>>();
const installUpdate = vi.fn<(filePath: string, version: string, opts?: { force: boolean }) => Promise<unknown>>();
const cancelInstall = vi.fn<() => Promise<unknown>>();
const installStatus = vi.hoisted(() => ({ emit: (_: unknown) => {} }));

vi.mock('@/lib/api', () => ({
  CLI_RELEASE_NOTICE_ID_PREFIX: 'claude-cli-update:',
  api: {
    getAppVersion: () => Promise.resolve('0.4.229'),
    checkForUpdate: () => checkForUpdate(),
    downloadUpdate: (url: string, asset: string) => downloadUpdate(url, asset),
    installUpdate: (f: string, v: string, o?: { force: boolean }) => installUpdate(f, v, o),
    cancelInstall: () => cancelInstall(),
    getClaudeCliReviewStatus: () => Promise.resolve(null),
    onSessionInFlightCount: () => () => {},
    onUpdateProgress: () => () => {},
    notifyClaudeCliRelease: () => Promise.resolve(false),
    onNotificationClicked: () => () => {},
    onInstallStatus: (cb: (d: unknown) => void) => {
      installStatus.emit = cb;
      return () => {};
    },
    brainActiveRun: () => Promise.resolve(null),
    onBrainRunProgress: () => () => {},
  },
}));

import { CustomTitlebar } from '@/components/CustomTitlebar';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  checkForUpdate.mockReset();
  downloadUpdate.mockReset();
  installUpdate.mockReset();
  cancelInstall.mockReset();
  checkForUpdate.mockResolvedValue({
    available: true,
    version: '0.4.230',
    downloadUrl: 'https://github.com/greychrist/omnifex/releases/download/v0.4.230/x.zip',
    assetName: 'OmniFex-darwin-arm64-0.4.230.zip',
    releaseUrl: 'https://github.com/greychrist/omnifex/releases/tag/v0.4.230',
  });
  downloadUpdate.mockResolvedValue(ZIP);
  cancelInstall.mockResolvedValue({ success: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  cleanup();
});

const installButton = () =>
  document.querySelector<HTMLButtonElement>('[data-app-update-install]');

/** Available → downloaded on its own → the popover's Install button. */
async function toReady() {
  vi.stubEnv('DEV', false);
  render(<CustomTitlebar />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  fireEvent.click(document.querySelector<HTMLButtonElement>('[data-updates-trigger]')!);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await waitFor(() => { expect(installButton()).not.toBeNull(); });
}

describe('CustomTitlebar — install wait cancelled', () => {
  it('goes back to Install, not an error, when the wait is cancelled', async () => {
    await toReady();
    // Main rejects the pending install once its wait loop sees the cancel.
    let rejectInstall: (e: Error) => void = () => {};
    installUpdate.mockImplementation(() => new Promise((_, rej) => { rejectInstall = rej; }));

    fireEvent.click(installButton()!);
    act(() => { installStatus.emit({ phase: 'waiting', activeSessions: 2 }); });
    await screen.findByText(/Waiting for 2 sessions/);
    expect(screen.getByText('Install anyway')).toBeTruthy();

    // Real order: the cancel IPC returns at once; main's wait loop only sees
    // the token on its next 1s poll, so the install rejects after that.
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => { expect(installButton()).not.toBeNull(); });
    await act(async () => {
      rejectInstall(new Error("Error invoking remote method 'updater:install': Error: WaitCancelled: WaitCancelled"));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(installButton()).not.toBeNull();
    expect(screen.queryByText(/install failed/)).toBeNull();
  });

  it('retries the install from the downloaded file when the install itself failed', async () => {
    await toReady();
    installUpdate.mockRejectedValueOnce(new Error('NotWritable: cannot write /Applications'));

    fireEvent.click(installButton()!);
    await screen.findByText(/install failed/);
    fireEvent.click(installButton()!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // The download already finished; a retry must not try to "download" a local path.
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
    expect(installUpdate).toHaveBeenCalledTimes(2);
    expect(installUpdate.mock.calls[1][0]).toBe(ZIP);
  });
});
