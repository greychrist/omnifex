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
    accountIdentityVerdict: vi.fn(),
    subscribeAccountIdentity: vi.fn(),
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
    expected_email: null,
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
  apiMock.accountIdentityVerdict.mockReset().mockResolvedValue(null);
  apiMock.subscribeAccountIdentity.mockReset().mockReturnValue(() => {});
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

  // -------------------------------------------------------------------------
  // Expected-vs-detected email badge.
  // -------------------------------------------------------------------------

  describe('account identity badge', () => {
    const WITH_EXPECTATION = makeAccount({
      id: 1,
      name: 'Personal',
      expected_email: 'work@example.com',
    });

    it('shows a mismatch badge when the detected email differs from expected', async () => {
      apiMock.listAccounts.mockResolvedValue([WITH_EXPECTATION]);
      apiMock.accountIdentityVerdict.mockResolvedValue({
        status: 'mismatch',
        expected: 'work@example.com',
        detected: 'personal@example.com',
        configDir: '/home/test/.claude-personal',
      });

      render(<AccountSettings />);

      expect(await screen.findByText(/signed in as personal@example\.com/i)).toBeTruthy();
    });

    // A passing check must produce POSITIVE evidence. Rendering nothing on
    // success makes "verified", "not configured", and "the check itself never
    // ran" indistinguishable — which defeats the point of a safety check.
    it('shows the verified email when expected and detected agree', async () => {
      apiMock.listAccounts.mockResolvedValue([WITH_EXPECTATION]);
      apiMock.accountIdentityVerdict.mockResolvedValue({
        status: 'verified',
        expected: 'work@example.com',
        detected: 'WORK@example.com',
        configDir: '/home/test/.claude-personal',
      });

      render(<AccountSettings />);

      expect(await screen.findByText(/verified: WORK@example\.com/i)).toBeTruthy();
      // ...and specifically NOT the failure phrasing.
      expect(screen.queryByText(/signed in as/i)).toBeNull();
      expect(screen.queryByText(/not signed in/i)).toBeNull();
    });

    it('distinguishes an unreadable identity from being signed out', async () => {
      apiMock.listAccounts.mockResolvedValue([WITH_EXPECTATION]);
      apiMock.accountIdentityVerdict.mockRejectedValue(new Error('IPC blew up'));

      render(<AccountSettings />);

      // A failed read is NOT evidence of being logged out — saying "not signed
      // in" here would be an outright false claim about account state.
      expect(await screen.findByText(/couldn't verify/i)).toBeTruthy();
      expect(screen.queryByText(/not signed in/i)).toBeNull();
    });

    it('shows nothing at all for an account that opted out', async () => {
      apiMock.listAccounts.mockResolvedValue([makeAccount({ expected_email: null })]);

      render(<AccountSettings />);
      await screen.findByText('Personal');

      expect(screen.queryByText(/verified:/i)).toBeNull();
      expect(screen.queryByText(/couldn't verify/i)).toBeNull();
      expect(screen.queryByText(/not signed in/i)).toBeNull();
    });

    it('shows a not-signed-in badge when no identity can be read', async () => {
      apiMock.listAccounts.mockResolvedValue([WITH_EXPECTATION]);
      apiMock.accountIdentityVerdict.mockResolvedValue({
        status: 'signed-out',
        expected: 'work@example.com',
        detected: null,
        configDir: '/home/test/.claude-personal',
      });

      render(<AccountSettings />);

      expect(await screen.findByText(/not signed in/i)).toBeTruthy();
    });

    it('shows no verdict before the identity read resolves', async () => {
      apiMock.listAccounts.mockResolvedValue([WITH_EXPECTATION]);
      // Never resolves — this is the pre-load state. Without a `loaded` flag
      // the row would flash "Not signed in" on every Settings open.
      apiMock.accountIdentityVerdict.mockReturnValue(new Promise(() => { /* pending */ }));

      render(<AccountSettings />);
      await screen.findByText('Personal');

      expect(screen.queryByText(/not signed in/i)).toBeNull();
      expect(screen.queryByText(/signed in as/i)).toBeNull();
      expect(screen.queryByText(/verified:/i)).toBeNull();
      expect(screen.queryByText(/couldn't verify/i)).toBeNull();
    });

    it('clicking the badge re-checks', async () => {
      apiMock.listAccounts.mockResolvedValue([WITH_EXPECTATION]);
      apiMock.accountIdentityVerdict.mockResolvedValue({
        status: 'mismatch',
        expected: 'work@example.com',
        detected: 'personal@example.com',
        configDir: '/home/test/.claude-personal',
      });

      render(<AccountSettings />);
      await screen.findByText(/signed in as personal@example\.com/i);
      const callsBefore = apiMock.accountIdentityVerdict.mock.calls.length;

      // The user has re-logged-in elsewhere; the next read finds it fixed.
      apiMock.accountIdentityVerdict.mockResolvedValue({
        status: 'verified',
        expected: 'work@example.com',
        detected: 'work@example.com',
        configDir: '/home/test/.claude-personal',
      });
      fireEvent.click(screen.getByRole('button', { name: /re-check account identity/i }));

      await waitFor(() => {
        expect(apiMock.accountIdentityVerdict.mock.calls.length).toBeGreaterThan(callsBefore);
      });
      expect(await screen.findByText(/verified: work@example\.com/i)).toBeTruthy();
    });

    // The watcher is what makes a logout/login done in a terminal self-correct
    // without the user hunting for a refresh.
    it('self-corrects when the identity changes on disk', async () => {
      let push: ((v: unknown) => void) | null = null;
      apiMock.subscribeAccountIdentity.mockImplementation(
        (_dir: string, cb: (v: unknown) => void) => {
          push = cb;
          return () => {};
        },
      );
      apiMock.listAccounts.mockResolvedValue([WITH_EXPECTATION]);
      apiMock.accountIdentityVerdict.mockResolvedValue({
        status: 'signed-out',
        expected: 'work@example.com',
        detected: null,
        configDir: '/home/test/.claude-personal',
      });

      render(<AccountSettings />);
      await screen.findByText(/not signed in/i);

      // Main observed a real change on disk and pushed the new verdict.
      push!({
        status: 'verified',
        expected: 'work@example.com',
        detected: 'work@example.com',
        configDir: '/home/test/.claude-personal',
      });

      expect(await screen.findByText(/verified: work@example\.com/i)).toBeTruthy();
      expect(screen.queryByText(/not signed in/i)).toBeNull();
    });

    it('never asks for a verdict for an account with no expected_email', async () => {
      apiMock.listAccounts.mockResolvedValue([makeAccount({ expected_email: null })]);

      render(<AccountSettings />);
      await screen.findByText('Personal');

      expect(apiMock.accountIdentityVerdict).not.toHaveBeenCalled();
    });
  });
});
