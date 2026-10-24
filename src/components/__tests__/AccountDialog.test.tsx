// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Account, CodexAuthStatus } from '@/lib/api';

// Hoist mocks alongside vi.mock() factories. See CodexSignInModal.test.tsx
// for the rationale — bare consts would land after the hoisted factory.
const { apiMock, useCodexAuthStatusMock } = vi.hoisted(() => ({
  apiMock: {
    getHomeDirectory: vi.fn(),
    codexLogout: vi.fn(),
    getCodexBinaryPath: vi.fn(),
    subscribeCodexAuthStatus: vi.fn(),
    listSupportedModels: vi.fn(),
    getClaudeSettings: vi.fn(),
    probeAccountAuthStatus: vi.fn(),
  },
  useCodexAuthStatusMock: vi.fn(),
}));

const { platformMock, signInBrowserMock } = vi.hoisted(() => ({
  platformMock: { isDesktop: true, listBrowsers: vi.fn() },
  signInBrowserMock: { getSignInBrowser: vi.fn(), setSignInBrowser: vi.fn() },
}));
vi.mock('@/lib/platform', () => ({ platform: platformMock }));
vi.mock('@/lib/signInBrowser', () => signInBrowserMock);

vi.mock('@/lib/api', () => ({
  api: apiMock,
}));

vi.mock('@/hooks/useCodexAuthStatus', () => ({
  useCodexAuthStatus: useCodexAuthStatusMock,
}));

// Stub the heavy children so jsdom doesn't choke (CodexSignInModal pulls in
// xterm via OneShotTerminal; IconPicker pulls in framer-motion). Neither is
// under test here.
vi.mock('@/components/codex/CodexSignInModal', () => ({
  CodexSignInModal: () => <div data-testid="codex-signin-modal" />,
}));

vi.mock('../IconPicker', () => ({
  IconPicker: () => <div data-testid="icon-picker" />,
  ICON_MAP: { user: () => <span data-testid="icon-user" /> },
}));

beforeEach(() => {
  apiMock.getHomeDirectory.mockReset().mockResolvedValue('/home/test');
  apiMock.codexLogout.mockReset().mockResolvedValue(undefined);
  apiMock.listSupportedModels.mockReset().mockResolvedValue([]);
  apiMock.getClaudeSettings.mockReset().mockResolvedValue({});
  apiMock.probeAccountAuthStatus.mockReset().mockResolvedValue(null);
  useCodexAuthStatusMock.mockReset().mockReturnValue(null);
  platformMock.isDesktop = true;
  platformMock.listBrowsers.mockReset().mockResolvedValue([
    { bundleId: 'com.google.Chrome', name: 'Google Chrome' },
    { bundleId: 'com.apple.Safari', name: 'Safari' },
  ]);
  signInBrowserMock.getSignInBrowser.mockReset().mockResolvedValue(null);
  signInBrowserMock.setSignInBrowser.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

// Import after mocks so the module under test resolves them.
import { AccountDialog } from '../AccountDialog';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 1,
    name: 'Personal',
    config_dir: '/home/test/.codex',
    engine: 'codex',
    subscription_label: 'Plus',
    has_cost: true,
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

describe('AccountDialog', () => {
  it('add mode: engine radios enabled, Claude default; no Thinking dropdown on either engine', () => {
    render(
      <AccountDialog mode="add" open={true} onClose={() => {}} onSave={() => {}} />,
    );

    const claudeRadio = screen.getByRole('radio', { name: /claude/i });
    const codexRadio = screen.getByRole('radio', { name: /codex/i });

    expect((claudeRadio as HTMLInputElement).disabled).toBe(false);
    expect((codexRadio as HTMLInputElement).disabled).toBe(false);
    expect((claudeRadio as HTMLInputElement).checked).toBe(true);

    // Thinking picker was removed (always adaptive) — absent for Claude...
    expect(screen.queryByLabelText(/thinking/i)).toBeNull();

    // ...and remains absent on Codex.
    fireEvent.click(codexRadio);
    expect((codexRadio as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText(/thinking/i)).toBeNull();
  });

  it('edit mode with a codex account: codex radio is checked and disabled', () => {
    render(
      <AccountDialog
        mode="edit"
        account={makeAccount({ engine: 'codex' })}
        open={true}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );

    const claudeRadio = screen.getByRole('radio', { name: /claude/i });
    const codexRadio = screen.getByRole('radio', { name: /codex/i });

    expect((codexRadio as HTMLInputElement).checked).toBe(true);
    expect((codexRadio as HTMLInputElement).disabled).toBe(true);
    expect((claudeRadio as HTMLInputElement).disabled).toBe(true);
  });

  it('edit + codex + authenticated: shows the email and a Sign out button', () => {
    const status: CodexAuthStatus = {
      authenticated: true,
      mode: 'oauth',
      email: 'x@y.com',
    };
    useCodexAuthStatusMock.mockReturnValue(status);

    render(
      <AccountDialog
        mode="edit"
        account={makeAccount({ engine: 'codex' })}
        open={true}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );

    expect(screen.getByText('x@y.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy();
  });

  it('Save fires onSave with the entered/toggled values including hasCost:false', () => {
    const onSave = vi.fn();
    render(
      <AccountDialog mode="add" open={true} onClose={() => {}} onSave={onSave} />,
    );

    fireEvent.change(screen.getByLabelText(/name/i), {
      target: { value: 'My Account' },
    });
    fireEvent.change(screen.getByLabelText(/config directory/i), {
      target: { value: '/home/test/.claude-x' },
    });
    fireEvent.change(screen.getByLabelText(/subscription/i), {
      target: { value: 'Max' },
    });
    // Default hasCost is true — toggle it off.
    fireEvent.click(screen.getByLabelText(/has cost/i));

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'My Account',
        configDir: '/home/test/.claude-x',
        engine: 'claude',
        subscriptionLabel: 'Max',
        hasCost: false,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Expected login email — the secondary confirmation that a config dir is
  // authenticated as the account we think it is.
  // -------------------------------------------------------------------------

  describe('expected email', () => {
    const claudeAccount = (overrides: Partial<Account> = {}): Account =>
      makeAccount({ engine: 'claude', config_dir: '/home/test/.claude', ...overrides });

    it('edit mode seeds the email field from account.expected_email', () => {
      render(
        <AccountDialog
          mode="edit"
          account={claudeAccount({ expected_email: 'a@example.com' })}
          open={true}
          onClose={() => {}}
          onSave={() => {}}
        />,
      );
      expect((screen.getByLabelText(/^email$/i) as HTMLInputElement).value).toBe(
        'a@example.com',
      );
    });

    it('saves the typed email as expectedEmail', () => {
      const onSave = vi.fn();
      render(
        <AccountDialog
          mode="edit"
          account={claudeAccount()}
          open={true}
          onClose={() => {}}
          onSave={onSave}
        />,
      );
      fireEvent.change(screen.getByLabelText(/^email$/i), {
        target: { value: 'b@example.com' },
      });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ expectedEmail: 'b@example.com' }),
      );
    });

    it('saves null when the field is emptied, so the check is turned off', () => {
      const onSave = vi.fn();
      render(
        <AccountDialog
          mode="edit"
          account={claudeAccount({ expected_email: 'a@example.com' })}
          open={true}
          onClose={() => {}}
          onSave={onSave}
        />,
      );
      fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ expectedEmail: null }),
      );
    });

    it('trims whitespace-only input to null rather than storing blanks', () => {
      const onSave = vi.fn();
      render(
        <AccountDialog
          mode="edit"
          account={claudeAccount({ expected_email: 'a@example.com' })}
          open={true}
          onClose={() => {}}
          onSave={onSave}
        />,
      );
      fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: '   ' } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ expectedEmail: null }),
      );
    });

    it('Detect fills the field from the CLI probe', async () => {
      apiMock.probeAccountAuthStatus.mockResolvedValue({
        loggedIn: true,
        email: 'detected@example.com',
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        orgName: 'Org',
        subscriptionType: 'max',
      });
      render(
        <AccountDialog
          mode="edit"
          account={claudeAccount()}
          open={true}
          onClose={() => {}}
          onSave={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /detect/i }));
      await waitFor(() => {
        expect((screen.getByLabelText(/^email$/i) as HTMLInputElement).value).toBe(
          'detected@example.com',
        );
      });
      expect(apiMock.probeAccountAuthStatus).toHaveBeenCalledWith('/home/test/.claude');
    });

    it('Detect reports when no signed-in account is found', async () => {
      apiMock.probeAccountAuthStatus.mockResolvedValue({
        loggedIn: false,
        email: null,
        authMethod: null,
        apiProvider: null,
        orgName: null,
        subscriptionType: null,
      });
      render(
        <AccountDialog
          mode="edit"
          account={claudeAccount()}
          open={true}
          onClose={() => {}}
          onSave={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /detect/i }));
      await waitFor(() => {
        expect(screen.getByText(/no signed-in account/i)).toBeTruthy();
      });
    });

    it('does not render the email field for codex accounts', () => {
      render(
        <AccountDialog
          mode="edit"
          account={makeAccount({ engine: 'codex' })}
          open={true}
          onClose={() => {}}
          onSave={() => {}}
        />,
      );
      expect(screen.queryByLabelText(/^email$/i)).toBeNull();
    });
  });
});

describe('AccountDialog — sign-in browser', () => {
  const claude = () => makeAccount({ engine: 'claude', config_dir: '/home/test/.claude-work' });

  it("lists the Mac's browsers and shows the account's current choice", async () => {
    signInBrowserMock.getSignInBrowser.mockResolvedValue('com.apple.Safari');
    render(<AccountDialog mode="edit" account={claude()} open onClose={() => {}} onSave={() => {}} />);
    const select = await screen.findByLabelText('Sign-in browser') as HTMLSelectElement;
    await waitFor(() => { expect(select.value).toBe('com.apple.Safari'); });
    expect([...select.options].map((o) => o.textContent)).toEqual(['Default browser', 'Google Chrome', 'Safari']);
    expect(signInBrowserMock.getSignInBrowser).toHaveBeenCalledWith('/home/test/.claude-work');
  });

  it('stores the choice on Save', async () => {
    render(<AccountDialog mode="edit" account={claude()} open onClose={() => {}} onSave={() => {}} />);
    const select = await screen.findByLabelText('Sign-in browser');
    await screen.findByRole('option', { name: 'Google Chrome' });
    fireEvent.change(select, { target: { value: 'com.google.Chrome' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(signInBrowserMock.setSignInBrowser).toHaveBeenCalledWith('/home/test/.claude-work', 'com.google.Chrome');
    });
  });

  it('is not offered where the browser cannot be chosen, or for Codex', () => {
    platformMock.isDesktop = false;
    render(<AccountDialog mode="edit" account={claude()} open onClose={() => {}} onSave={() => {}} />);
    expect(screen.queryByLabelText('Sign-in browser')).toBeNull();
    cleanup();
    platformMock.isDesktop = true;
    render(<AccountDialog mode="edit" account={makeAccount()} open onClose={() => {}} onSave={() => {}} />);
    expect(screen.queryByLabelText('Sign-in browser')).toBeNull();
  });
});
