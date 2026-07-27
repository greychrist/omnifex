// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { IdentityStatus } from '@/lib/api';

vi.mock('@/contexts/AccountsContext', () => ({
  useAccounts: () => ({
    accounts: [],
    refresh: async () => {},
    getColor: () => null,
    getIcon: () => null,
    getAccountType: () => 'Enterprise',
  }),
}));

vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray' }),
}));

// The engine brand mark, stubbed so we can assert whether it was displaced by
// a shield.
vi.mock('../shared/BrandIcon', () => ({
  BrandIcon: () => <span data-testid="brand-icon" />,
}));

vi.mock('../IconPicker', () => ({
  ICON_MAP: { user: () => <span data-testid="icon-user" /> },
}));

import { AccountBadge } from '../AccountBadge';

afterEach(() => {
  cleanup();
});

function renderBadge(verification?: IdentityStatus | null) {
  return render(
    <AccountBadge name="Work" agent="claude" verification={verification} />,
  );
}

describe('AccountBadge verification shield', () => {
  it('shows a check shield when the account is verified', () => {
    renderBadge('verified');
    expect(screen.getByRole('img', { name: /expected account/i })).toBeTruthy();
  });

  it('shows an alert shield when a different account is signed in', () => {
    renderBadge('mismatch');
    expect(screen.getByRole('img', { name: /different account/i })).toBeTruthy();
  });

  it('shows an alert shield when the config dir is signed out', () => {
    renderBadge('signed-out');
    expect(screen.getByRole('img', { name: /not signed in/i })).toBeTruthy();
  });

  it('shows a question shield when nothing owns the config dir', () => {
    renderBadge('unknown-account');
    expect(screen.getByRole('img', { name: /couldn't verify/i })).toBeTruthy();
  });

  it('replaces the engine brand mark when a verdict is shown', () => {
    renderBadge('verified');
    // The trailing slot holds one mark, not two — the shield takes it over.
    expect(screen.queryByTestId('brand-icon')).toBeNull();
  });

  // Asserting "verified" with no expectation configured would be a claim we
  // haven't earned, so the badge stays exactly as it was.
  it('keeps the brand mark and shows no shield when verification is unconfigured', () => {
    renderBadge('unverified');
    expect(screen.getByTestId('brand-icon')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('keeps the brand mark when no verdict has been supplied at all', () => {
    renderBadge(null);
    expect(screen.getByTestId('brand-icon')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
