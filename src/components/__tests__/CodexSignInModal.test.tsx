// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import type { CodexAuthStatus } from '@/lib/api';

// Hoist the API mock alongside vi.mock() so factory closure references
// resolve before the module under test imports `@/lib/api`. Without
// vi.hoisted the bare `const apiMock = ...` would land *after* the
// hoisted vi.mock() factory and fail with "Cannot access 'apiMock'
// before initialization".
const { apiMock } = vi.hoisted(() => {
  return {
    apiMock: {
      getCodexBinaryPath: vi.fn(),
      getHomeDirectory: vi.fn(),
      subscribeCodexAuthStatus: vi.fn(),
      oneShotTerminalSpawn: vi.fn(),
      oneShotTerminalKill: vi.fn(),
      oneShotTerminalWrite: vi.fn(),
      oneShotTerminalResize: vi.fn(),
      fsExists: vi.fn(),
    },
  };
});

vi.mock('@/lib/api', () => ({
  api: apiMock,
}));

// OneShotTerminal pulls in @xterm/* which doesn't play nice in jsdom (it
// needs a real canvas). Stub it with a placeholder div so the modal can
// render and the spawn IPC isn't actually invoked.
vi.mock('@/components/shared/OneShotTerminal', () => ({
  OneShotTerminal: (props: { binary: string; args: string[] }) => (
    <div
      data-testid="one-shot-terminal"
      data-binary={props.binary}
      data-args={JSON.stringify(props.args)}
    />
  ),
}));

// Capture the latest auth-status subscriber so tests can drive the
// "auth flipped to authenticated" event without going through IPC.
const authSubscribers: ((status: CodexAuthStatus) => void)[] = [];

beforeEach(() => {
  authSubscribers.length = 0;
  apiMock.getCodexBinaryPath.mockReset();
  apiMock.getHomeDirectory.mockReset();
  apiMock.subscribeCodexAuthStatus.mockReset();

  // Default: binary resolves; home dir is /home/test; subscribe captures cb.
  apiMock.getCodexBinaryPath.mockResolvedValue('/opt/homebrew/bin/codex');
  apiMock.getHomeDirectory.mockResolvedValue('/home/test');
  apiMock.subscribeCodexAuthStatus.mockImplementation((cb: (s: CodexAuthStatus) => void) => {
    authSubscribers.push(cb);
    return () => {
      const idx = authSubscribers.indexOf(cb);
      if (idx >= 0) authSubscribers.splice(idx, 1);
    };
  });
});

afterEach(() => {
  cleanup();
});

// Import after mocks are set up so the module under test resolves them.
import { CodexSignInModal } from '../codex/CodexSignInModal';

describe('CodexSignInModal', () => {
  it('does not render the dialog contents when open=false', () => {
    render(<CodexSignInModal open={false} onClose={() => {}} />);
    expect(screen.queryByText('Sign in to Codex')).toBeNull();
    // Subscription is only set up when open=true.
    expect(apiMock.subscribeCodexAuthStatus).not.toHaveBeenCalled();
    expect(apiMock.getCodexBinaryPath).not.toHaveBeenCalled();
  });

  it('subscribes to auth status and resolves the codex binary on open', async () => {
    render(<CodexSignInModal open={true} onClose={() => {}} />);
    expect(screen.getByText('Sign in to Codex')).toBeTruthy();
    expect(apiMock.subscribeCodexAuthStatus).toHaveBeenCalledTimes(1);
    expect(apiMock.getCodexBinaryPath).toHaveBeenCalledTimes(1);

    // Once the binary resolver responds, OneShotTerminal is mounted with
    // the resolved binary + ['login'] args.
    await waitFor(() => {
      expect(screen.getByTestId('one-shot-terminal').getAttribute('data-binary')).toBe(
        '/opt/homebrew/bin/codex',
      );
      expect(screen.getByTestId('one-shot-terminal').getAttribute('data-args')).toBe(
        JSON.stringify(['login']),
      );
    });
  });

  it('renders the "Codex CLI not found" fallback when binary resolves to null', async () => {
    apiMock.getCodexBinaryPath.mockResolvedValue(null);
    render(<CodexSignInModal open={true} onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/Codex CLI not found/i)).toBeTruthy();
    });
    // No terminal is mounted in the not-found path.
    expect(screen.queryByTestId('one-shot-terminal')).toBeNull();
  });

  it('auto-closes when auth status flips to authenticated', async () => {
    const onClose = vi.fn();
    const onAuthenticated = vi.fn();
    render(
      <CodexSignInModal
        open={true}
        onClose={onClose}
        onAuthenticated={onAuthenticated}
      />,
    );

    // Wait for the subscription to be registered.
    await waitFor(() => {
      expect(authSubscribers.length).toBe(1);
    });

    // Fire the "authenticated" event through the captured subscriber.
    act(() => {
      authSubscribers[0]({ authenticated: true, mode: 'oauth', email: 'x@y.com' });
    });

    expect(onAuthenticated).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-close when an unauthenticated status flips through (e.g. logout race)', async () => {
    const onClose = vi.fn();
    render(<CodexSignInModal open={true} onClose={onClose} />);

    await waitFor(() => {
      expect(authSubscribers.length).toBe(1);
    });

    // Unauthenticated event: modal stays open so the user can finish the
    // login flow they're already in.
    act(() => {
      authSubscribers[0]({ authenticated: false });
    });

    expect(onClose).not.toHaveBeenCalled();
  });
});
