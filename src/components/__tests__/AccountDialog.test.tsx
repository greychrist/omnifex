// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Account, CodexAuthStatus } from '@/lib/api';

// Hoist mocks alongside vi.mock() factories. See CodexSignInModal.test.tsx
// for the rationale — bare consts would land after the hoisted factory.
const { apiMock, useCodexAuthStatusMock } = vi.hoisted(() => ({
  apiMock: {
    getHomeDirectory: vi.fn(),
    codexLogout: vi.fn(),
    getCodexBinaryPath: vi.fn(),
    subscribeCodexAuthStatus: vi.fn(),
  },
  useCodexAuthStatusMock: vi.fn(),
}));

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
  useCodexAuthStatusMock.mockReset().mockReturnValue(null);
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
});
