// @vitest-environment jsdom
import * as React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { SessionVerification } from '@/lib/accountVerification';
import type { RateLimitSnapshot, SessionCostSnapshot } from '@/lib/api';

const accountsRef: { color: string | null; icon: string | null; type: string | null } = {
  color: '#3b82f6',
  icon: null,
  type: 'max',
};
vi.mock('@/contexts/AccountsContext', () => ({
  useAccounts: () => ({
    accounts: [],
    refresh: async () => {},
    getColor: () => accountsRef.color,
    getIcon: () => accountsRef.icon,
    getAccountType: () => accountsRef.type,
  }),
}));
vi.mock('@/hooks', () => ({ useTheme: () => ({ theme: 'gray', setTheme: async () => {} }) }));
vi.mock('@/lib/api', () => ({ api: { claudeLogout: vi.fn() } }));
vi.mock('@/lib/platform', () => ({ platform: { isElectron: true } }));
vi.mock('../ClaudeSignInModal', () => ({ ClaudeSignInModal: () => null }));
vi.mock('../claude-code-session/UsageDetailPopover', () => ({
  UsageDetailPopover: (props: {
    trigger: React.ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div>
      <div onClick={() => { props.onOpenChange(!props.open); }}>{props.trigger}</div>
      {props.open && <div data-testid="usage-detail" />}
    </div>
  ),
}));

import { AccountStatusItem } from '../AccountStatusItem';

const verified: SessionVerification = {
  status: 'verified',
  needsRestart: false,
  expected: 'me@me.com',
  detected: 'me@me.com',
};

const snapshot = (type: string) => (utilization: number, status: RateLimitSnapshot['status'] = 'allowed'): RateLimitSnapshot => ({
  account_name: 'Personal',
  rate_limit_type: type,
  status,
  utilization,
  resets_at: null,
  observed_at: Date.now(),
});
const fiveHour = snapshot('five_hour');
const sevenDay = snapshot('seven_day');

const cost = (totalUsd: number): SessionCostSnapshot => ({
  totalUsd,
  estimated: false,
  breakdown: { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0 },
  subagentUsd: 0,
  byModel: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

const usage = { data: null, loading: false, refresh: vi.fn(async () => {}), sessionCost: null };

const base = {
  accountName: 'Personal',
  agent: 'claude' as const,
  verification: verified,
  configDir: '/Users/me/.claude-personal',
  matchType: 'path_rule',
  matchDetail: '~/Repos/personal',
  usage,
};

beforeEach(() => {
  accountsRef.color = '#3b82f6';
  accountsRef.icon = null;
  accountsRef.type = 'max';
});
afterEach(() => { cleanup(); });

const accountButton = (): HTMLElement => screen.getByRole('button', { name: /^account/i });
const usageButton = (): HTMLElement => screen.getByRole('button', { name: /usage/i });

describe('AccountStatusItem', () => {
  describe('the readout', () => {
    it('reads icon, "account", then name: type', () => {
      render(<AccountStatusItem {...base} />);
      const btn = accountButton();
      expect(btn.querySelector('svg')).toBeTruthy();
      expect(screen.getByText('account').className).toContain('opacity-70');
      expect(screen.getByTestId('account-item-name').textContent).toBe('Personal: max');
    });

    it('leaves the type off when the account has none', () => {
      accountsRef.type = null;
      render(<AccountStatusItem {...base} />);
      expect(screen.getByTestId('account-item-name').textContent).toBe('Personal');
    });

    // The account's own colour carries the icon, label and name, as it does on
    // the badge — that is what makes it recognisable at a glance.
    it('wears the account colour', () => {
      render(<AccountStatusItem {...base} />);
      expect(accountButton().style.color).toBe('rgb(59, 130, 246)');
    });

    it('falls back to a name-hashed colour class when the account has none', () => {
      accountsRef.color = null;
      render(<AccountStatusItem {...base} />);
      expect(accountButton().className).toMatch(/\btext-\w+-400\b/);
    });

    it.each([
      ['verified', /signed in as the expected account/i],
      ['mismatch', /different account/i],
      ['signed-out', /not signed in/i],
    ] as const)('shows the %s shield', (status, label) => {
      render(<AccountStatusItem {...base} verification={{ ...verified, status }} />);
      expect(screen.getByRole('img', { name: label })).toBeTruthy();
    });

    it('shows the expired-sign-in shield over a verified config dir', () => {
      render(
        <AccountStatusItem
          {...base}
          sessionAuthFailure={{ at: '2026-09-29T19:43:40Z', text: 'expired' }}
        />,
      );
      expect(screen.getByRole('img', { name: /sign-in expired/i })).toBeTruthy();
    });

    // Nothing to attest: no shield, and no claim we haven't earned.
    it('shows no shield for an account with no expected email', () => {
      render(<AccountStatusItem {...base} verification={null} />);
      expect(screen.queryByRole('img')).toBeNull();
    });

    // Block-level for the same reason as the other popover readouts: an
    // inline-flex trigger opens a line box and sits ~1px high.
    it('makes both buttons block-level so they centre with the plain readouts', () => {
      render(<AccountStatusItem {...base} fiveHourRateLimit={fiveHour(42)} />);
      for (const b of [accountButton(), usageButton()]) {
        expect(b.className).toMatch(/(^|\s)flex(\s|$)/);
        expect(b.className).not.toMatch(/\binline-flex\b/);
      }
    });
  });

  describe('usage', () => {
    it('shows the 5-hour and weekly percentages on a time-limited account', () => {
      render(<AccountStatusItem {...base} fiveHourRateLimit={fiveHour(42)} sevenDayRateLimit={sevenDay(18)} />);
      expect(screen.getByTestId('account-item-usage').textContent).toBe('42%');
      expect(screen.getByTestId('account-item-usage-week').textContent).toBe('18%');
      expect(usageButton().querySelector('svg.lucide-clock')).toBeTruthy();
      expect(usageButton().querySelector('svg.lucide-calendar-days')).toBeTruthy();
    });

    // A size step under the bar's other glyphs: two of them sit side by side.
    it('draws the window icons a size smaller than the bar\'s other icons', () => {
      render(<AccountStatusItem {...base} fiveHourRateLimit={fiveHour(42)} sevenDayRateLimit={sevenDay(18)} />);
      for (const sel of ['svg.lucide-clock', 'svg.lucide-calendar-days']) {
        const cls = usageButton().querySelector(sel)!.getAttribute('class')!;
        expect(cls).toMatch(/(^|\s)h-3(\s|$)/);
        expect(cls).toMatch(/(^|\s)w-3(\s|$)/);
      }
    });

    it('colours the weekly percentage by its own level', () => {
      render(<AccountStatusItem {...base} fiveHourRateLimit={fiveHour(10)} sevenDayRateLimit={sevenDay(95)} />);
      expect(screen.getByTestId('account-item-usage').className).toContain('text-foreground');
      expect(screen.getByTestId('account-item-usage-week').className).toContain('text-red-400');
    });

    it('shows a dash for a window with no snapshot yet', () => {
      render(<AccountStatusItem {...base} fiveHourRateLimit={fiveHour(42)} sevenDayRateLimit={null} />);
      expect(screen.getByTestId('account-item-usage-week').textContent).toBe('—');
    });

    it.each([
      [30, 'text-foreground'],
      [60, 'text-yellow-400'],
      [80, 'text-orange-400'],
      [95, 'text-red-400'],
    ] as const)('colours %s%% like the rate-limit widget does', (pct, cls) => {
      render(<AccountStatusItem {...base} fiveHourRateLimit={fiveHour(pct)} />);
      expect(screen.getByTestId('account-item-usage').className).toContain(cls);
    });

    // Pulses whenever it is coloured — yellow, orange or red — like the
    // thinking readout; only the window that is coloured.
    it.each([
      [30, false],
      [60, true],
      [80, true],
      [95, true],
    ] as const)('pulses %s%%: %s', (pct, pulses) => {
      render(<AccountStatusItem {...base} fiveHourRateLimit={fiveHour(pct)} sevenDayRateLimit={sevenDay(10)} />);
      expect(screen.getByTestId('account-item-usage').classList.contains('animate-pulse')).toBe(pulses);
      expect(screen.getByTestId('account-item-usage-week').classList.contains('animate-pulse')).toBe(false);
    });

    it('pulses a rejected window', () => {
      render(<AccountStatusItem {...base} fiveHourRateLimit={fiveHour(20, 'rejected')} />);
      expect(screen.getByTestId('account-item-usage').classList.contains('animate-pulse')).toBe(true);
    });

    it('shows a dash before the first rate-limit snapshot', () => {
      render(<AccountStatusItem {...base} fiveHourRateLimit={null} />);
      expect(screen.getByTestId('account-item-usage').textContent).toBe('—');
    });

    it('shows the dollars spent on a cost-based account', () => {
      render(<AccountStatusItem {...base} hasCost usage={{ ...usage, sessionCost: cost(1.234) }} />);
      expect(screen.getByTestId('account-item-usage').textContent).toBe('1.23');
      expect(usageButton().querySelector('svg.lucide-dollar-sign')).toBeTruthy();
      expect(usageButton().querySelector('svg.lucide-clock')).toBeNull();
      expect(screen.queryByTestId('account-item-usage-week')).toBeNull();
    });
  });

  describe('the popovers', () => {
    it('opens the account details from the name', () => {
      render(<AccountStatusItem {...base} />);
      fireEvent.click(accountButton());
      expect(screen.getByText('/Users/me/.claude-personal')).toBeTruthy();
      expect(screen.getByText('path rule')).toBeTruthy();
      expect(screen.queryByTestId('usage-detail')).toBeNull();
    });

    it('opens the usage detail from the usage', () => {
      render(<AccountStatusItem {...base} fiveHourRateLimit={fiveHour(42)} />);
      fireEvent.click(usageButton());
      expect(screen.getByTestId('usage-detail')).toBeTruthy();
      expect(screen.queryByText('/Users/me/.claude-personal')).toBeNull();
    });
  });
});
