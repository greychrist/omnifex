// @vitest-environment jsdom
//
// Focused regression test for Task 25: the Codex section in AccountSettings
// is gated behind `OMNIFEX_ENABLE_CODEX=1`. We mock every collaborator
// AccountSettings touches at mount — the assertion target is purely the
// presence/absence of the "Codex" heading on the rendered panel under
// the two flag states.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

// Stub useAccounts (the AccountsProvider tree isn't mounted here).
vi.mock('@/contexts/AccountsContext', () => ({
  useAccounts: () => ({
    accounts: [],
    refresh: async () => {},
    getColor: () => null,
    getIcon: () => null,
    getAccountType: () => null,
  }),
}));

// AppCapabilitiesContext is the thing under test. Flip the value via a
// module-level binding so each `it` can opt in/out independently.
let testCodexEnabled = false;
vi.mock('@/contexts/AppCapabilitiesContext', () => ({
  useAppCapabilities: () => ({ codexEnabled: testCodexEnabled }),
}));

// useCodexAuthStatus subscribes to the auth-status watcher; stub it so
// the Codex row doesn't try to hit IPC when the gate is on.
vi.mock('@/hooks/useCodexAuthStatus', () => ({
  useCodexAuthStatus: () => ({ authenticated: false }),
}));

// CodexSignInModal renders a portal in its open path. Stub to a no-op so
// AccountSettings can mount without bringing in the modal's deps.
vi.mock('@/components/codex/CodexSignInModal', () => ({
  CodexSignInModal: () => null,
}));

// All api calls — AccountSettings hits several on mount.
vi.mock('@/lib/api', () => ({
  api: {
    listAccounts: vi.fn(async () => []),
    listPathRules: vi.fn(async () => []),
    listProjectOverrides: vi.fn(async () => []),
    getHomeDirectory: vi.fn(async () => '/home/test'),
    codexLogout: vi.fn(async () => {}),
  },
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AccountSettings — Codex feature flag (Task 25)', () => {
  it('hides the Codex section heading when codexEnabled is false', async () => {
    testCodexEnabled = false;
    const { AccountSettings } = await import('../AccountSettings');
    render(<AccountSettings />);
    // Wait for the panel to settle (any loaded list state).
    await waitFor(() => {
      // Path Rules heading should be present regardless — anchors the
      // wait without depending on Codex visibility.
      expect(screen.getByText('Path Rules')).toBeTruthy();
    });
    // Codex section heading must not be rendered.
    expect(screen.queryByRole('heading', { name: 'Codex' })).toBeNull();
    expect(screen.queryByText('Codex')).toBeNull();
  });

  it('renders the Codex section heading when codexEnabled is true', async () => {
    testCodexEnabled = true;
    const { AccountSettings } = await import('../AccountSettings');
    render(<AccountSettings />);
    await waitFor(() => {
      expect(screen.getByText('Path Rules')).toBeTruthy();
    });
    // Codex heading must be rendered.
    expect(screen.getByRole('heading', { name: 'Codex' })).toBeTruthy();
  });
});
