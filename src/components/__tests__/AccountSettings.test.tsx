// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Account } from '@/lib/api';

// Hoist mocks alongside the vi.mock() factories so the closure references
// resolve before the module under test imports them. See AccountDialog.test.tsx
// for the same pattern.
const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listAccounts: vi.fn(),
    listPathRules: vi.fn(),
    listProjectOverrides: vi.fn(),
    createAccount: vi.fn(),
    updateAccount: vi.fn(),
    deleteAccount: vi.fn(),
    addPathRule: vi.fn(),
    removePathRule: vi.fn(),
    scanForNewAccounts: vi.fn(),
    explainAccountResolution: vi.fn(),
    getHomeDirectory: vi.fn(),
  },
}));

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

// AccountBadge pulls AccountsContext + theme; render a lightweight stub that
// just surfaces the name so list assertions stay simple.
vi.mock('@/components/AccountBadge', () => ({
  AccountBadge: ({ name }: { name: string }) => <span data-testid="account-badge">{name}</span>,
}));

// AccountDialog is heavy (xterm via CodexSignInModal, framer-motion via
// IconPicker). Stub it down to a dialog whose accessible name reflects the
// mode so we can assert open/mode without exercising its internals. The
// stub also surfaces a "Save" button that fires onSave with a fixed payload
// so tests can drive the create/update wiring in AccountSettings.
const SAVE_PAYLOAD = {
  name: 'Edited',
  configDir: '/home/test/.claude-edited',
  engine: 'claude' as const,
  subscriptionLabel: 'Pro',
  hasCost: true,
  color: '#ff0000',
  icon: 'user',
  sessionDefaults: {},
};

vi.mock('@/components/AccountDialog', () => ({
  AccountDialog: (props: {
    open: boolean;
    mode: 'add' | 'edit';
    onSave: (payload: typeof SAVE_PAYLOAD) => void;
  }) =>
    props.open ? (
      <div role="dialog" aria-label={props.mode === 'add' ? 'Add account' : 'Edit account'}>
        <button type="button" onClick={() => { props.onSave(SAVE_PAYLOAD); }}>
          Dialog Save
        </button>
      </div>
    ) : null,
}));

afterEach(() => {
  cleanup();
});

import { AccountSettings } from '../AccountSettings';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 1,
    name: 'Personal',
    config_dir: '/home/test/.claude-personal',
    engine: 'claude',
    subscription_label: 'Max',
    has_cost: false,
    color: '#3b82f6',
    icon: 'user',
    session_defaults: {},
    cli_path: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

const CLAUDE_ACCOUNT = makeAccount({ id: 1, name: 'Personal', engine: 'claude' });
const CODEX_ACCOUNT = makeAccount({
  id: 2,
  name: 'Work',
  engine: 'codex',
  config_dir: '/home/test/.codex',
  subscription_label: 'Plus',
  has_cost: true,
});

beforeEach(() => {
  apiMock.listAccounts.mockReset().mockResolvedValue([CLAUDE_ACCOUNT, CODEX_ACCOUNT]);
  apiMock.listPathRules.mockReset().mockResolvedValue([]);
  apiMock.listProjectOverrides.mockReset().mockResolvedValue([]);
  apiMock.createAccount.mockReset().mockResolvedValue(undefined);
  apiMock.updateAccount.mockReset().mockResolvedValue(undefined);
  apiMock.deleteAccount.mockReset().mockResolvedValue(undefined);
  apiMock.addPathRule.mockReset().mockResolvedValue(undefined);
  apiMock.removePathRule.mockReset().mockResolvedValue(undefined);
  apiMock.scanForNewAccounts.mockReset().mockResolvedValue([]);
  apiMock.explainAccountResolution.mockReset().mockResolvedValue(null);
  apiMock.getHomeDirectory.mockReset().mockResolvedValue('/home/test');
});

describe('AccountSettings', () => {
  it('renders Claude and Codex accounts in one list, engine-disambiguated', async () => {
    render(<AccountSettings />);

    // Both account names land in the same list.
    expect(await screen.findByText('Personal')).toBeTruthy();
    expect(screen.getByText('Work')).toBeTruthy();

    // Engine markers present for both. The EnginePill renders "Claude"/"Codex"
    // text; assert both appear (case-insensitive, the pill uppercases via CSS).
    expect(screen.getAllByText(/claude/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/codex/i).length).toBeGreaterThan(0);
  });

  it('clicking "Add account" opens the dialog in add mode', async () => {
    render(<AccountSettings />);
    await screen.findByText('Personal');

    fireEvent.click(screen.getByRole('button', { name: /add account/i }));

    expect(screen.getByRole('dialog', { name: /add account/i })).toBeTruthy();
  });

  it("clicking a row's Edit opens the dialog in edit mode", async () => {
    render(<AccountSettings />);
    await screen.findByText('Personal');

    fireEvent.click(screen.getByRole('button', { name: /edit personal/i }));

    expect(screen.getByRole('dialog', { name: /edit account/i })).toBeTruthy();
  });

  it('clicking "Scan for accounts" calls scanForNewAccounts and refreshes', async () => {
    apiMock.scanForNewAccounts.mockResolvedValue([CODEX_ACCOUNT]);
    render(<AccountSettings />);
    await screen.findByText('Personal');

    const callsBeforeScan = apiMock.listAccounts.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: /scan for accounts/i }));

    await waitFor(() => {
      expect(apiMock.scanForNewAccounts).toHaveBeenCalledTimes(1);
    });
    // A non-empty scan triggers a reload of the account list.
    await waitFor(() => {
      expect(apiMock.listAccounts.mock.calls.length).toBeGreaterThan(callsBeforeScan);
    });
  });

  it('saving from add mode calls createAccount with the engine', async () => {
    render(<AccountSettings />);
    await screen.findByText('Personal');

    fireEvent.click(screen.getByRole('button', { name: /add account/i }));
    fireEvent.click(screen.getByRole('button', { name: /dialog save/i }));

    await waitFor(() => {
      expect(apiMock.createAccount).toHaveBeenCalledTimes(1);
    });
    expect(apiMock.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ engine: 'claude', name: 'Edited' }),
    );
    expect(apiMock.updateAccount).not.toHaveBeenCalled();
  });

  it('saving from edit mode calls updateAccount with the row account id', async () => {
    render(<AccountSettings />);
    await screen.findByText('Personal');

    fireEvent.click(screen.getByRole('button', { name: /edit work/i }));
    fireEvent.click(screen.getByRole('button', { name: /dialog save/i }));

    await waitFor(() => {
      expect(apiMock.updateAccount).toHaveBeenCalledTimes(1);
    });
    // Work is account id 2 — update must target it, not create a new account.
    expect(apiMock.updateAccount).toHaveBeenCalledWith(2, expect.objectContaining({ name: 'Edited' }));
    expect(apiMock.createAccount).not.toHaveBeenCalled();
  });

  it('deleting an account calls deleteAccount and refreshes', async () => {
    render(<AccountSettings />);
    await screen.findByText('Personal');

    fireEvent.click(screen.getByRole('button', { name: /delete personal/i }));

    await waitFor(() => {
      expect(apiMock.deleteAccount).toHaveBeenCalledWith(1);
    });
  });
});
