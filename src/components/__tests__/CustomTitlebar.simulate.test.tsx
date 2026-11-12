// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react';
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
const updateClaudeCli = vi.fn<() => Promise<unknown>>();
const saveSetting = vi.fn<(k: string, v: string) => Promise<void>>();
const clicks = vi.hoisted(() => ({ emit: (_: unknown) => {} }));

vi.mock('@/lib/api', () => ({
  CLI_RELEASE_NOTICE_ID_PREFIX: 'claude-cli-update:',
  CLI_CHECKED_VERSION_SETTING_KEY: 'claude_cli.checked_version',
  api: {
    getAppVersion: () => Promise.resolve('0.4.152'),
    checkForUpdate: () => checkForUpdate(),
    downloadUpdate: (u: string, a: string) => downloadUpdate(u, a),
    installUpdate: (f: string, v: string, o?: unknown) => installUpdate(f, v, o),
    cancelInstall: () => Promise.resolve({ success: true }),
    getClaudeCliReviewStatus: () => getClaudeCliReviewStatus(),
    updateClaudeCli: () => updateClaudeCli(),
    saveSetting: (k: string, v: string) => saveSetting(k, v),
    notifyClaudeCliRelease: (v: string) => notifyClaudeCliRelease(v),
    onNotificationClicked: (cb: (d: unknown) => void) => { clicks.emit = cb; return () => {}; },
    onSessionInFlightCount: () => () => {},
    onUpdateProgress: () => () => {},
    onInstallStatus: () => () => {},
    brainActiveRun: () => Promise.resolve(null),
    onBrainRunProgress: () => () => {},
  },
}));

import { CustomTitlebar, UPDATE_SIMULATION_STORAGE_KEY } from '@/components/CustomTitlebar';

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

const ZIP = '/tmp/omnifex-update/OmniFex-darwin-arm64-0.4.153.zip';

const trigger = () => document.querySelector<HTMLButtonElement>('[data-updates-trigger]')!;
const icon = () => document.querySelector('[data-updates-icon]')!;
const settle = (ms = 1000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const box = (name: RegExp) => screen.getByRole<HTMLInputElement>('checkbox', { name });
const cls = () => icon().getAttribute('class') ?? '';
async function openPopover() {
  render(<CustomTitlebar />);
  await settle();
  fireEvent.click(trigger());
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubEnv('DEV', true);
  localStorage.clear();
  getClaudeCliReviewStatus.mockReset().mockResolvedValue(status());
  checkForUpdate.mockReset().mockResolvedValue(null);
  downloadUpdate.mockReset().mockResolvedValue(ZIP);
  installUpdate.mockReset().mockResolvedValue(undefined);
  notifyClaudeCliRelease.mockReset().mockResolvedValue(true);
  updateClaudeCli.mockReset().mockResolvedValue({});
  saveSetting.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  cleanup();
  localStorage.clear();
});

// A dev build can't see either update for real: it never downloads a release,
// its version already matches the latest, and the installed CLI is usually
// current. These boxes fake each state the Updates button can be in, for the
// display only — nothing they show can install, update or notify anything.
describe('CustomTitlebar — dev update simulation', () => {
  it('fakes a Claude Code release: green, pulsing, and the row says so', async () => {
    await openPopover();
    expect(icon().getAttribute('data-upgrade')).toBeNull();
    fireEvent.click(box(/claude code update/i));
    expect(icon().getAttribute('data-upgrade')).toBe('true');
    expect(cls()).toMatch(/animate-pulse/);
    expect(screen.getByText('2.1.322 → 9.9.9 available')).toBeTruthy();
  });

  it('never runs a real claude update or announces the fake release', async () => {
    await openPopover();
    fireEvent.click(box(/claude code update/i));
    fireEvent.click(document.querySelector('[data-cli-update-run]')!);
    await settle();
    expect(updateClaudeCli).not.toHaveBeenCalled();
    expect(notifyClaudeCliRelease).not.toHaveBeenCalledWith('9.9.9');
  });

  it('fakes a downloaded OmniFex release whose Install does nothing', async () => {
    await openPopover();
    fireEvent.click(box(/omnifex update/i));
    expect(cls()).toMatch(/animate-pulse/);
    expect(screen.getByText('OmniFex 0.4.152 → 9.9.9 ready')).toBeTruthy();
    fireEvent.click(document.querySelector('[data-app-update-install]')!);
    await settle();
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it('fakes an unreviewed Claude Code without marking anything checked', async () => {
    await openPopover();
    fireEvent.click(box(/not yet reviewed/i));
    expect(document.querySelector('[data-updates-unreviewed]')).not.toBeNull();
    expect(icon().getAttribute('data-upgrade')).toBeNull();
    fireEvent.click(document.querySelector('[data-cli-review-mark]')!);
    await settle();
    expect(saveSetting).not.toHaveBeenCalled();
  });

  it('sets each box independently', async () => {
    await openPopover();
    fireEvent.click(box(/claude code update/i));
    fireEvent.click(box(/omnifex update/i));
    fireEvent.click(box(/not yet reviewed/i));
    expect(screen.getByText('2.1.322 → 9.9.9 available')).toBeTruthy();
    expect(screen.getByText('OmniFex 0.4.152 → 9.9.9 ready')).toBeTruthy();
    expect(document.querySelector('[data-updates-unreviewed]')).not.toBeNull();
    fireEvent.click(box(/claude code update/i));
    expect(screen.queryByText('2.1.322 → 9.9.9 available')).toBeNull();
    expect(screen.getByText('OmniFex 0.4.152 → 9.9.9 ready')).toBeTruthy();
    expect(document.querySelector('[data-updates-unreviewed]')).not.toBeNull();
  });

  it('survives a reload', async () => {
    await openPopover();
    fireEvent.click(box(/omnifex update/i));
    cleanup();
    await openPopover();
    expect(box(/omnifex update/i).checked).toBe(true);
    expect(cls()).toMatch(/animate-pulse/);
  });

  it('does not exist outside a dev build, even with a stored simulation', async () => {
    localStorage.setItem(UPDATE_SIMULATION_STORAGE_KEY, JSON.stringify({ cli: true, app: true, unreviewed: true }));
    vi.stubEnv('DEV', false);
    await openPopover();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(icon().getAttribute('data-upgrade')).toBeNull();
    expect(document.querySelector('[data-updates-unreviewed]')).toBeNull();
  });
});
