// @vitest-environment jsdom
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { SessionVerification } from '@/lib/accountVerification';

const { apiMock, platformMock } = vi.hoisted(() => ({
  apiMock: { claudeLogout: vi.fn() },
  platformMock: { platform: { isElectron: true } },
}));

vi.mock('@/lib/api', () => ({ api: apiMock }));
vi.mock('@/lib/platform', () => platformMock);
vi.mock('@/hooks/useUsageAutoRefresh', () => ({
  useUsageAutoRefresh: () => ({ data: null, loading: false, refresh: vi.fn() }),
}));
vi.mock('@/hooks/useSessionCost', () => ({ useSessionCost: () => null }));
vi.mock('@/hooks/useLayoutMode', () => ({ useLayoutMode: () => ({ narrow: false }) }));

// The real Popover portals and animates; a controlled passthrough is enough
// to reach the account-identity controls.
vi.mock('@/components/ui/popover', () => ({
  Popover: (props: {
    trigger: React.ReactNode;
    content: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div>
      <div onClick={() => props.onOpenChange?.(!props.open)}>{props.trigger}</div>
      {props.open && <div data-testid="popover-content">{props.content}</div>}
    </div>
  ),
}));
vi.mock('../AccountBadge', () => ({ AccountBadge: () => <span>badge</span> }));
vi.mock('../claude-code-session/UsageDetailPopover', () => ({
  UsageDetailPopover: (props: { trigger: React.ReactNode }) => <div>{props.trigger}</div>,
}));

type ModalProps = { open: boolean; configDir: string; onAuthenticated?: () => void };
let lastModalProps: ModalProps | null = null;
vi.mock('../ClaudeSignInModal', () => ({
  ClaudeSignInModal: (props: ModalProps) => {
    lastModalProps = props;
    return props.open ? <div data-testid="claude-sign-in-modal" /> : null;
  },
}));

import { AccountCard } from '../AccountCard';

const CONFIG_DIR = '/Users/me/.claude-work';

function verification(status: SessionVerification['status']): SessionVerification {
  return {
    status,
    needsRestart: false,
    expected: 'me@work.com',
    detected: status === 'signed-out' ? null : 'me@work.com',
  };
}

function renderCard(overrides: Partial<React.ComponentProps<typeof AccountCard>> = {}) {
  const onRecheck = vi.fn();
  render(
    <AccountCard
      accountName="Work"
      agent="claude"
      verification={verification('verified')}
      onRecheck={onRecheck}
      configDir={CONFIG_DIR}
      matchType="path_rule"
      matchDetail="~/Repos/work"
      {...overrides}
    />,
  );
  fireEvent.click(screen.getByTitle('Click for account details'));
  return { onRecheck };
}

beforeEach(() => {
  lastModalProps = null;
  apiMock.claudeLogout.mockReset();
  apiMock.claudeLogout.mockResolvedValue(undefined);
  platformMock.platform.isElectron = true;
});

afterEach(() => { cleanup(); });

describe('AccountCard — sign in / sign out', () => {
  it('offers Sign out and Re-authenticate for a signed-in Claude account', () => {
    renderCard();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /re-authenticate/i })).toBeTruthy();
  });

  it('offers only Sign in when nobody is signed in to the config dir', () => {
    renderCard({ verification: verification('signed-out'), signedInEmail: null });
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
  });

  // An account with no expected email resolves to no verification at all.
  // Signing in and out does not depend on that check, so the controls must
  // not either — they follow who is signed in.
  it('offers Sign in with no expected email when nobody is signed in', () => {
    renderCard({ verification: null, signedInEmail: null });
    expect(screen.getByText('Not signed in')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
  });

  it('names the signed-in account with no expected email, and offers Sign out', () => {
    renderCard({ verification: null, signedInEmail: 'colby@work.com' });
    expect(screen.getByText('colby@work.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: /re-authenticate/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy();
  });

  it('offers both controls while who is signed in is still unknown', () => {
    renderCard({ verification: null, signedInEmail: undefined });
    expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /re-authenticate/i })).toBeTruthy();
  });

  // The identity verdict is only re-read on an on-disk login change. Editing
  // the expected email in Settings is neither, so the card's refresh button
  // must re-run the check too — with no expected email there is no Re-check.
  it('re-checks the account identity from the card refresh button', () => {
    const { onRecheck } = renderCard({ verification: null });
    fireEvent.click(screen.getByTitle('Refresh account identity and usage'));
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it('asks for confirmation before signing out, then re-checks', async () => {
    const { onRecheck } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(apiMock.claudeLogout).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /confirm sign out/i }));
    await waitFor(() => { expect(apiMock.claudeLogout).toHaveBeenCalledWith(CONFIG_DIR); });
    await waitFor(() => { expect(onRecheck).toHaveBeenCalled(); });
  });

  it('shows the CLI error when sign out fails', async () => {
    apiMock.claudeLogout.mockRejectedValue(new Error('claude auth logout failed: keychain locked'));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm sign out/i }));
    expect(await screen.findByText(/keychain locked/)).toBeTruthy();
  });

  it('opens the sign-in terminal for this config dir and re-checks on success', () => {
    const { onRecheck } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /re-authenticate/i }));
    expect(screen.getByTestId('claude-sign-in-modal')).toBeTruthy();
    expect(lastModalProps!.configDir).toBe(CONFIG_DIR);

    lastModalProps!.onAuthenticated!();
    expect(onRecheck).toHaveBeenCalled();
  });

  it('hides the controls for Codex sessions, which sign in from Account Settings', () => {
    renderCard({ agent: 'codex' });
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /re-authenticate/i })).toBeNull();
  });

  it('hides the controls in the web client, which has no pty to log in with', () => {
    platformMock.platform.isElectron = false;
    renderCard();
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /re-authenticate/i })).toBeNull();
  });
});
