// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

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

vi.mock('@/lib/api', () => ({
  api: {
    getAppVersion: () => Promise.resolve('0.4.158'),
    checkForUpdate: () => Promise.resolve(null),
    getClaudeCliReviewStatus: () => Promise.resolve(null),
    updateClaudeCli: () => Promise.resolve({}),
    onSessionInFlightCount: () => () => {},
    onUpdateProgress: () => () => {},
    onInstallStatus: () => () => {},
    brainActiveRun: () => Promise.resolve(null),
    onBrainRunProgress: () => () => {},
    listTabStatuses: () => Promise.resolve([]),
    onTabStatusesChanged: () => () => {},
  },
}));

vi.mock('@/contexts/TabContext', () => ({
  useTabContext: () => ({ tabs: [], setActiveTab: () => {} }),
}));

import { CustomTitlebar } from '@/components/CustomTitlebar';
import { TITLEBAR_LABEL } from '@/lib/titlebar';

afterEach(cleanup);

/**
 * The right-hand button group carries icon + word. Below the `lg` viewport
 * the words go and the icons stay, so a narrow window keeps every button
 * instead of wrapping or clipping the group. jsdom evaluates no media
 * queries, so this pins the responsive classes and the fallback name each
 * icon-only button keeps for hover and assistive tech.
 */
describe('title-bar buttons on a narrow window', () => {
  it('hides every label below lg and keeps a title on the button', () => {
    render(
      <CustomTitlebar onSettingsClick={() => {}} onLimaClick={() => {}} onBrainClick={() => {}} onCostClick={() => {}} />,
    );
    expect(TITLEBAR_LABEL.split(' ')).toEqual(expect.arrayContaining(['hidden', 'lg:inline']));
    for (const label of ['Daemon', 'Lima', 'Brain', 'Cost', 'Sessions', 'Settings', 'Updates']) {
      const span = screen.getByText(label, { selector: 'button span' });
      expect(span.className, label).toContain('hidden');
      expect(span.className, label).toContain('lg:inline');
      const button = span.closest('button')!;
      expect(button.getAttribute('title') || button.getAttribute('aria-label'), `${label} button name`).toBeTruthy();
    }
  });
});
