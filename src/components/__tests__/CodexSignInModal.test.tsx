// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import type { CodexAuthStatus } from '@/lib/api';

// Hoisted: a bare const would land after the hoisted vi.mock factory.
const { apiMock } = vi.hoisted(() => {
  return {
    apiMock: {
      getCodexBinaryPath: vi.fn(),
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

// @xterm/* needs a real canvas, which jsdom lacks.
vi.mock('@/components/shared/OneShotTerminal', () => ({
  OneShotTerminal: (props: { binary: string; args: string[] }) => (
    <div
      data-testid="one-shot-terminal"
      data-binary={props.binary}
      data-args={JSON.stringify(props.args)}
    />
  ),
}));

const authSubscribers: ((status: CodexAuthStatus) => void)[] = [];

const CONFIG_DIR = '/home/test/.codex';

beforeEach(() => {
  authSubscribers.length = 0;
  apiMock.getCodexBinaryPath.mockReset();
  apiMock.subscribeCodexAuthStatus.mockReset();

  apiMock.getCodexBinaryPath.mockResolvedValue('/opt/homebrew/bin/codex');
  apiMock.subscribeCodexAuthStatus.mockImplementation(
    (_configDir: string, cb: (s: CodexAuthStatus) => void) => {
      authSubscribers.push(cb);
      return () => {
        const idx = authSubscribers.indexOf(cb);
        if (idx >= 0) authSubscribers.splice(idx, 1);
      };
    },
  );
});

afterEach(() => {
  cleanup();
});

import { CodexSignInModal } from '../codex/CodexSignInModal';

describe('CodexSignInModal', () => {
  it('does not render the dialog contents when open=false', () => {
    render(<CodexSignInModal open={false} onClose={() => {}} configDir={CONFIG_DIR} />);
    expect(screen.queryByText('Sign in to Codex')).toBeNull();
    expect(apiMock.subscribeCodexAuthStatus).not.toHaveBeenCalled();
    expect(apiMock.getCodexBinaryPath).not.toHaveBeenCalled();
  });

  it('subscribes to auth status for the configDir and resolves the codex binary on open', async () => {
    render(<CodexSignInModal open={true} onClose={() => {}} configDir={CONFIG_DIR} />);
    expect(screen.getByText('Sign in to Codex')).toBeTruthy();
    expect(apiMock.subscribeCodexAuthStatus).toHaveBeenCalledTimes(1);
    expect(apiMock.subscribeCodexAuthStatus).toHaveBeenCalledWith(
      CONFIG_DIR,
      expect.any(Function),
    );
    expect(apiMock.getCodexBinaryPath).toHaveBeenCalledTimes(1);

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
    render(<CodexSignInModal open={true} onClose={() => {}} configDir={CONFIG_DIR} />);
    await waitFor(() => {
      expect(screen.getByText(/Codex CLI not found/i)).toBeTruthy();
    });
    expect(screen.queryByTestId('one-shot-terminal')).toBeNull();
  });

  it('auto-closes when auth status flips to authenticated', async () => {
    const onClose = vi.fn();
    const onAuthenticated = vi.fn();
    render(
      <CodexSignInModal
        open={true}
        onClose={onClose}
        configDir={CONFIG_DIR}
        onAuthenticated={onAuthenticated}
      />,
    );

    await waitFor(() => {
      expect(authSubscribers.length).toBe(1);
    });

    act(() => {
      authSubscribers[0]({ authenticated: true, mode: 'oauth', email: 'x@y.com' });
    });

    expect(onAuthenticated).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-close when an unauthenticated status flips through (e.g. logout race)', async () => {
    const onClose = vi.fn();
    render(<CodexSignInModal open={true} onClose={onClose} configDir={CONFIG_DIR} />);

    await waitFor(() => {
      expect(authSubscribers.length).toBe(1);
    });

    act(() => {
      authSubscribers[0]({ authenticated: false });
    });

    expect(onClose).not.toHaveBeenCalled();
  });
});
