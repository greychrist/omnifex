// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { Account } from '@/lib/api';
import { AccountPickerDialog } from '@/components/AccountPickerDialog';

// Hoisted: bare consts would land after the hoisted vi.mock factory.
const { apiMock } = vi.hoisted(() => {
  return {
    apiMock: {
      listAccounts: vi.fn(),
      setProjectAccountOverride: vi.fn(),
    },
  };
});

vi.mock('@/lib/api', () => ({
  api: apiMock,
}));

vi.mock('@/contexts/AccountsContext', () => ({
  useAccounts: () => ({
    accounts: [],
    refresh: async () => {},
    getColor: () => null,
    getIcon: () => null,
    getAccountType: () => null,
  }),
}));

vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: async () => {} }),
}));

function makeAccount(partial: Partial<Account> & Pick<Account, 'id' | 'name' | 'engine'>): Account {
  return {
    config_dir: '',
    subscription_label: '',
    has_cost: false,
    color: null,
    icon: null,
    cli_path: null,
    expected_email: null,
    created_at: '',
    updated_at: '',
    ...partial,
  };
}

const CLAUDE_ACCOUNT = makeAccount({ id: 1, name: 'Personal-Claude', engine: 'claude' });
const CODEX_ACCOUNT = makeAccount({ id: 2, name: 'Personal-Codex', engine: 'codex' });

beforeEach(() => {
  apiMock.listAccounts.mockReset();
  apiMock.setProjectAccountOverride.mockReset();
  apiMock.listAccounts.mockResolvedValue([CLAUDE_ACCOUNT, CODEX_ACCOUNT]);
});

afterEach(() => { cleanup(); });

describe('AccountPickerDialog — engineFilter', () => {
  it('shows only codex accounts when engineFilter="codex"', async () => {
    render(
      <AccountPickerDialog
        open
        onOpenChange={() => {}}
        projectPath="/repos/alpha"
        onAccountSelected={() => {}}
        engineFilter="codex"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Personal-Codex')).toBeTruthy();
    });
    expect(screen.queryByText('Personal-Claude')).toBeNull();
  });

  it('shows all accounts when engineFilter is unset', async () => {
    render(
      <AccountPickerDialog
        open
        onOpenChange={() => {}}
        projectPath="/repos/alpha"
        onAccountSelected={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Personal-Claude')).toBeTruthy();
    });
    expect(screen.getByText('Personal-Codex')).toBeTruthy();
  });
});
