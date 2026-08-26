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
        // forwardRef, not a bare function: the Updates button is a Radix
        // TooltipTrigger `asChild`, which hands the trigger a ref.
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

// The sessions popover pulls in TabContext; it's irrelevant here.
vi.mock('@/components/TabStatusPopover', () => ({
  TabStatusPopover: () => null,
}));

const getClaudeCliReviewStatus = vi.fn<() => Promise<CliReviewStatus | null>>();

vi.mock('@/lib/api', () => ({
  api: {
    getAppVersion: () => Promise.resolve('0.4.109'),
    checkForUpdate: () => Promise.resolve(null),
    getClaudeCliReviewStatus: () => getClaudeCliReviewStatus(),
    onSessionInFlightCount: () => () => {},
    onUpdateProgress: () => () => {},
    onInstallStatus: () => () => {},
    // The titlebar hosts the Brain run indicator. Nothing indexing is the
    // right default here — these tests are about the changelog watermark.
    brainActiveRun: () => Promise.resolve(null),
    onBrainRunProgress: () => () => {},
  },
}));

import { CustomTitlebar } from '@/components/CustomTitlebar';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  getClaudeCliReviewStatus.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/**
 * Render, let the on-mount check and its minimum-spin hold settle, then open
 * the Updates popover. Radix only mounts TooltipContent while open, so the
 * version rows don't exist in the DOM until the trigger is focused.
 */
async function renderSettled() {
  const result = render(<CustomTitlebar />);
  // MIN_CHECK_SPIN_MS is 700; the dot is suppressed while a check is in
  // flight, so the hold has to elapse before the badge can appear.
  await vi.advanceTimersByTimeAsync(1000);
  fireEvent.focus(screen.getByText('Updates').closest('button')!);
  await vi.advanceTimersByTimeAsync(300);
  return result;
}

const dot = () => document.querySelector('[data-cli-unreviewed]');
// Radix mirrors tooltip content into an aria-hidden copy for screen readers,
// so every string inside the popover matches twice.
const seen = (text: string | RegExp) => screen.queryAllByText(text).length;

describe('CustomTitlebar — Claude Code changelog watermark', () => {
  it('badges the Updates button when the installed CLI is ahead of the watermark', async () => {
    getClaudeCliReviewStatus.mockResolvedValue({
      installed_version: '2.1.230',
      reviewed_version: '2.1.222',
      unreviewed: true,
      latest_version: null,
      upgrade_available: false,
      repo_dir: null,
    });
    await renderSettled();

    await waitFor(() => { expect(dot()).not.toBeNull(); });
    // The popover explains *which* watermark we're behind, so the badge
    // isn't a mystery dot.
    expect(seen(/ahead of the 2\.1\.222 changelog/)).toBeGreaterThan(0);
    expect(seen('2.1.230')).toBeGreaterThan(0);
  });

  it('shows no badge when the CLI matches the watermark', async () => {
    getClaudeCliReviewStatus.mockResolvedValue({
      installed_version: '2.1.222',
      reviewed_version: '2.1.222',
      unreviewed: false,
      latest_version: null,
      upgrade_available: false,
      repo_dir: null,
    });
    await renderSettled();

    await waitFor(() => { expect(seen('2.1.222')).toBeGreaterThan(0); });
    expect(dot()).toBeNull();
    expect(seen(/ahead of the/)).toBe(0);
  });

  it('reports "not found" rather than badging when no CLI is installed', async () => {
    // A missing binary is a different problem from an unreviewed changelog;
    // flagging drift we can't measure would be a false alarm.
    getClaudeCliReviewStatus.mockResolvedValue({
      installed_version: null,
      reviewed_version: '2.1.222',
      unreviewed: false,
      latest_version: null,
      upgrade_available: false,
      repo_dir: null,
    });
    await renderSettled();

    await waitFor(() => { expect(seen('not found')).toBeGreaterThan(0); });
    expect(dot()).toBeNull();
  });

  /**
   * The bug this closes: the Claude Code row reported only the installed
   * version, so a popover titled "Check for Upgrade" sat at what looked like a
   * steady state while three CLI releases shipped. The CLI self-updates only
   * when it is launched directly — OmniFex's own pty spawns don't trigger it —
   * so nothing here was ever going to say a newer release existed.
   */
  it('offers the newer published release next to the installed one', async () => {
    getClaudeCliReviewStatus.mockResolvedValue({
      installed_version: '2.1.241',
      reviewed_version: '2.1.241',
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
      unreviewed: true,
      latest_version: '2.1.246',
      upgrade_available: false,
      repo_dir: null,
    });
    await renderSettled();

    await waitFor(() => { expect(seen('2.1.246')).toBeGreaterThan(0); });
    // No "→ available" noise on the steady state, which is most of the time.
    expect(seen(/available/)).toBe(0);
  });

  it('says nothing about upgrades when the registry was unreachable', async () => {
    // Offline must degrade to the old row, not to a false "up to date".
    getClaudeCliReviewStatus.mockResolvedValue({
      installed_version: '2.1.241',
      reviewed_version: '2.1.241',
      unreviewed: false,
      latest_version: null,
      upgrade_available: false,
      repo_dir: null,
    });
    await renderSettled();

    await waitFor(() => { expect(seen('2.1.241')).toBeGreaterThan(0); });
    expect(seen(/available/)).toBe(0);
  });

  /**
   * The chosen semantics: an available upgrade is not reviewable drift. The
   * amber dot keeps meaning "the binary you are running has moved past our
   * watermark", because that is the only case a review pass can act on.
   */
  it('does not badge the button for an upgrade the user has not installed', async () => {
    getClaudeCliReviewStatus.mockResolvedValue({
      installed_version: '2.1.241',
      reviewed_version: '2.1.241',
      unreviewed: false,
      latest_version: '2.1.246',
      upgrade_available: true,
      repo_dir: '/repo',
    });
    await renderSettled();

    await waitFor(() => { expect(seen(/2\.1\.246 available/)).toBeGreaterThan(0); });
    expect(dot()).toBeNull();
    expect(seen(/ahead of the/)).toBe(0);
  });

  it('stays silent when the status call fails', async () => {
    getClaudeCliReviewStatus.mockResolvedValue(null);
    await renderSettled();

    expect(dot()).toBeNull();
    expect(seen('Claude Code')).toBe(0);
    // The app row still renders — a CLI probe failure must not take the
    // rest of the popover down with it.
    expect(seen('OmniFex 0.4.109')).toBeGreaterThan(0);
  });
});

describe('CustomTitlebar — launching the changelog review', () => {
  const drifted = (repo_dir: string | null): CliReviewStatus => ({
    installed_version: '2.1.224',
    reviewed_version: '2.1.222',
    unreviewed: true,
    latest_version: null,
    upgrade_available: false,
    repo_dir,
  });

  // Radix duplicates tooltip content for screen readers, so the launch button
  // exists twice; both copies are wired to the same handler.
  const launchButtons = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[data-cli-review-launch]'));

  it('makes the drift warning clickable when a repo is resolved', async () => {
    const onCliReviewClick = vi.fn();
    getClaudeCliReviewStatus.mockResolvedValue(drifted('/repos/omnifex'));
    render(<CustomTitlebar onCliReviewClick={onCliReviewClick} />);
    await vi.advanceTimersByTimeAsync(1000);
    fireEvent.focus(screen.getByText('Updates').closest('button')!);
    await vi.advanceTimersByTimeAsync(300);

    await waitFor(() => { expect(launchButtons().length).toBeGreaterThan(0); });
    fireEvent.click(launchButtons()[0]);
    // The handler gets the range that actually drifted, not just a ping.
    expect(onCliReviewClick).toHaveBeenCalledWith({
      repoDir: '/repos/omnifex',
      reviewedVersion: '2.1.222',
      installedVersion: '2.1.224',
    });
  });

  it('stays plain text when no OmniFex checkout could be found', async () => {
    // A launch button with nowhere to launch is worse than no button; point
    // at the setting that fixes it instead.
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
      unreviewed: false,
      latest_version: null,
      upgrade_available: false,
      repo_dir: '/repos/omnifex',
    });
    render(<CustomTitlebar onCliReviewClick={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(1000);
    fireEvent.focus(screen.getByText('Updates').closest('button')!);
    await vi.advanceTimersByTimeAsync(300);

    await waitFor(() => { expect(seen('2.1.222')).toBeGreaterThan(0); });
    expect(launchButtons()).toHaveLength(0);
  });
});
