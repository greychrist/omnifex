// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent, act } from '@testing-library/react';
import type { CliReviewStatus } from '@/lib/api';

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

vi.mock('@/components/TabStatusPopover', () => ({ TabStatusPopover: () => null }));

const getClaudeCliReviewStatus = vi.fn<() => Promise<CliReviewStatus | null>>();
const checkForUpdate = vi.fn<() => Promise<unknown>>();
const downloadUpdate = vi.fn<(url: string, asset: string) => Promise<string>>();
const installUpdate = vi.fn<(f: string, v: string, o?: unknown) => Promise<unknown>>();
const notifyClaudeCliRelease = vi.fn<(v: string) => Promise<boolean>>();
const clicks = vi.hoisted(() => ({ emit: (_: unknown) => {} }));

vi.mock('@/lib/api', () => ({
  CLI_RELEASE_NOTICE_ID_PREFIX: 'claude-cli-update:',
  api: {
    getAppVersion: () => Promise.resolve('0.4.152'),
    checkForUpdate: () => checkForUpdate(),
    downloadUpdate: (u: string, a: string) => downloadUpdate(u, a),
    installUpdate: (f: string, v: string, o?: unknown) => installUpdate(f, v, o),
    cancelInstall: () => Promise.resolve({ success: true }),
    getClaudeCliReviewStatus: () => getClaudeCliReviewStatus(),
    updateClaudeCli: () => Promise.resolve({}),
    notifyClaudeCliRelease: (v: string) => notifyClaudeCliRelease(v),
    onNotificationClicked: (cb: (d: unknown) => void) => { clicks.emit = cb; return () => {}; },
    onSessionInFlightCount: () => () => {},
    onUpdateProgress: () => () => {},
    onInstallStatus: () => () => {},
    brainActiveRun: () => Promise.resolve(null),
    onBrainRunProgress: () => () => {},
  },
}));

import { CustomTitlebar, BACKGROUND_CHECK_MS } from '@/components/CustomTitlebar';

const status = (over: Partial<CliReviewStatus> = {}): CliReviewStatus => ({
  installed_version: '2.1.322',
  reviewed_version: '2.1.322',
  checked_version: '2.1.322',
  unreviewed: false,
  latest_version: '2.1.322',
  upgrade_available: false,
  repo_dir: null,
  ...over,
});
const newer = () => status({ latest_version: '2.1.323', upgrade_available: true });

const APP_RELEASE = {
  available: true,
  version: '0.4.153',
  downloadUrl: 'https://example.invalid/x.zip',
  assetName: 'OmniFex-darwin-arm64-0.4.153.zip',
  releaseUrl: 'https://example.invalid/tag',
};
const ZIP = '/tmp/omnifex-update/OmniFex-darwin-arm64-0.4.153.zip';

const trigger = () => document.querySelector<HTMLButtonElement>('[data-updates-trigger]')!;
const icon = () => document.querySelector('[data-updates-icon]')!;
const popoverOpen = () => document.querySelector('[data-app-update-row]') !== null;
const settle = (ms = 1000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubEnv('DEV', false);
  getClaudeCliReviewStatus.mockReset().mockResolvedValue(status());
  checkForUpdate.mockReset().mockResolvedValue(null);
  downloadUpdate.mockReset().mockResolvedValue(ZIP);
  installUpdate.mockReset().mockResolvedValue(undefined);
  notifyClaudeCliRelease.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  cleanup();
});

describe('CustomTitlebar — new Claude Code release notification', () => {
  it('announces a newly published release found by the launch check', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(newer());
    render(<CustomTitlebar />);
    await settle();
    expect(notifyClaudeCliRelease).toHaveBeenCalledTimes(1);
    expect(notifyClaudeCliRelease).toHaveBeenCalledWith('2.1.323');
  });

  it('does not re-announce the same version on later checks', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(newer());
    render(<CustomTitlebar />);
    await settle();
    fireEvent.click(trigger());
    await settle();
    await settle(BACKGROUND_CHECK_MS);
    expect(notifyClaudeCliRelease).toHaveBeenCalledTimes(1);
  });

  it('announces again when a still newer release appears', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(newer());
    render(<CustomTitlebar />);
    await settle();
    getClaudeCliReviewStatus.mockResolvedValue(status({ latest_version: '2.1.324', upgrade_available: true }));
    await settle(BACKGROUND_CHECK_MS);
    expect(notifyClaudeCliRelease).toHaveBeenLastCalledWith('2.1.324');
  });

  it('says nothing when the registry could not be reached', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(status({ latest_version: null, upgrade_available: false }));
    render(<CustomTitlebar />);
    await settle();
    expect(notifyClaudeCliRelease).not.toHaveBeenCalled();
    expect(icon().getAttribute('data-upgrade')).toBeNull();
  });

  it('opens the Updates popover when its notification is clicked', async () => {
    render(<CustomTitlebar />);
    await settle();
    expect(popoverOpen()).toBe(false);

    act(() => { clicks.emit({ tabId: null, id: 'claude-cli-update:2.1.323' }); });
    await waitFor(() => { expect(popoverOpen()).toBe(true); });
  });

  it('ignores clicks on other notifications', async () => {
    render(<CustomTitlebar />);
    await settle();
    act(() => { clicks.emit({ tabId: 'tab-1', id: null }); });
    act(() => { clicks.emit({ tabId: null, id: 'some-mod:1' }); });
    await settle(100);
    expect(popoverOpen()).toBe(false);
  });
});

describe('CustomTitlebar — background check', () => {
  it('re-checks both updates hourly without the popover, and without spinning', async () => {
    render(<CustomTitlebar />);
    await settle();
    const cli = getClaudeCliReviewStatus.mock.calls.length;
    const app = checkForUpdate.mock.calls.length;

    await act(async () => { await vi.advanceTimersByTimeAsync(BACKGROUND_CHECK_MS); });
    expect(getClaudeCliReviewStatus.mock.calls.length).toBe(cli + 1);
    expect(checkForUpdate.mock.calls.length).toBe(app + 1);
    expect(icon().getAttribute('class') ?? '').not.toMatch(/animate-spin/);
  });

  it('turns the icon green for a Claude Code release found in the background', async () => {
    render(<CustomTitlebar />);
    await settle();
    expect(icon().getAttribute('data-upgrade')).toBeNull();
    getClaudeCliReviewStatus.mockResolvedValue(newer());
    await settle(BACKGROUND_CHECK_MS);
    expect(icon().getAttribute('data-upgrade')).toBe('true');
    expect(icon().getAttribute('class')).toMatch(/text-emerald-500/);
  });
});

describe('CustomTitlebar — OmniFex update', () => {
  const installButton = () => document.querySelector<HTMLButtonElement>('[data-app-update-install]');
  const retryButton = () => document.querySelector<HTMLButtonElement>('[data-app-update-retry]');

  it('downloads a new release on its own and offers one Install button in the popover', async () => {
    checkForUpdate.mockResolvedValue(APP_RELEASE);
    render(<CustomTitlebar />);
    await settle();
    expect(downloadUpdate).toHaveBeenCalledWith(APP_RELEASE.downloadUrl, APP_RELEASE.assetName);
    expect(icon().getAttribute('data-upgrade')).toBe('true');

    fireEvent.click(trigger());
    await settle();
    expect(screen.getByText('OmniFex 0.4.152 → 0.4.153 ready')).toBeTruthy();
    fireEvent.click(installButton()!);
    await settle(0);
    expect(installUpdate).toHaveBeenCalledWith(ZIP, '0.4.153', undefined);
  });

  it('keeps a downloaded update across later checks', async () => {
    checkForUpdate.mockResolvedValue(APP_RELEASE);
    render(<CustomTitlebar />);
    await settle();
    fireEvent.click(trigger());           // open: checks again
    await settle();
    await settle(BACKGROUND_CHECK_MS);    // and the hourly check
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
    expect(installButton()).not.toBeNull();
  });

  it('offers a retry after a failed download, and retries on the next check', async () => {
    checkForUpdate.mockResolvedValue(APP_RELEASE);
    downloadUpdate.mockRejectedValueOnce(new Error('offline'));
    render(<CustomTitlebar />);
    await settle();
    fireEvent.click(trigger());
    await settle();
    // Opening the popover was itself a check, so the retry already ran.
    expect(downloadUpdate).toHaveBeenCalledTimes(2);
    expect(installButton()).not.toBeNull();

    cleanup();
    downloadUpdate.mockReset().mockRejectedValue(new Error('offline'));
    render(<CustomTitlebar />);
    await settle();
    fireEvent.click(trigger());
    await settle();
    expect(screen.getByText(/download failed/)).toBeTruthy();
    downloadUpdate.mockResolvedValue(ZIP);
    fireEvent.click(retryButton()!);
    await settle(0);
    await waitFor(() => { expect(installButton()).not.toBeNull(); });
  });

  it('does not download in a dev build', async () => {
    vi.stubEnv('DEV', true);
    checkForUpdate.mockResolvedValue(APP_RELEASE);
    render(<CustomTitlebar />);
    await settle();
    expect(downloadUpdate).not.toHaveBeenCalled();
    fireEvent.click(trigger());
    await settle();
    expect(screen.getByText('OmniFex 0.4.152 → 0.4.153 available')).toBeTruthy();
  });

  it('has no update pill outside the popover', async () => {
    checkForUpdate.mockResolvedValue(APP_RELEASE);
    render(<CustomTitlebar />);
    await settle();
    expect(screen.queryByText('Install Update')).toBeNull();
    expect(screen.queryByText('Update Available!')).toBeNull();
    expect(document.querySelector('[data-updates-indicator]')).toBeNull();
  });
});
