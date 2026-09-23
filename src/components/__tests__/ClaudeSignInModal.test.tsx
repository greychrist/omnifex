// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    startClaudeLoginFlow: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock }));

// xterm needs a real canvas; capture the props instead so tests can drive
// the spawn override and the exit callback directly.
type TerminalProps = {
  spawn?: (size: { cols: number; rows: number }) => Promise<{ ptyHandle: string }>;
  onExit?: (info: { exitCode: number }) => void;
};
let lastTerminalProps: TerminalProps | null = null;
vi.mock('@/components/shared/OneShotTerminal', () => ({
  OneShotTerminal: (props: TerminalProps) => {
    lastTerminalProps = props;
    return <div data-testid="one-shot-terminal" />;
  },
}));

import { ClaudeSignInModal } from '../ClaudeSignInModal';

const CONFIG_DIR = '/Users/me/.claude-work';

beforeEach(() => {
  lastTerminalProps = null;
  apiMock.startClaudeLoginFlow.mockReset();
  apiMock.startClaudeLoginFlow.mockResolvedValue({ ptyHandle: 'pty-1' });
});

afterEach(() => { cleanup(); });

describe('ClaudeSignInModal', () => {
  it('renders nothing when closed', () => {
    render(<ClaudeSignInModal open={false} onClose={() => {}} configDir={CONFIG_DIR} />);
    expect(screen.queryByTestId('one-shot-terminal')).toBeNull();
  });

  it('names the account and spawns the login through the account-scoped channel', async () => {
    render(<ClaudeSignInModal open onClose={() => {}} configDir={CONFIG_DIR} accountName="Work" />);
    expect(screen.getByText('Sign in to Claude — Work')).toBeTruthy();
    expect(screen.getByTestId('one-shot-terminal')).toBeTruthy();

    await lastTerminalProps!.spawn!({ cols: 100, rows: 24 });
    expect(apiMock.startClaudeLoginFlow).toHaveBeenCalledWith(CONFIG_DIR, { cols: 100, rows: 24 });
  });

  it('closes and reports success when the CLI exits cleanly', () => {
    const onClose = vi.fn();
    const onAuthenticated = vi.fn();
    render(
      <ClaudeSignInModal open onClose={onClose} configDir={CONFIG_DIR} onAuthenticated={onAuthenticated} />,
    );
    act(() => { lastTerminalProps!.onExit!({ exitCode: 0 }); });
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open on a failed login so the error remains readable', () => {
    const onClose = vi.fn();
    const onAuthenticated = vi.fn();
    render(
      <ClaudeSignInModal open onClose={onClose} configDir={CONFIG_DIR} onAuthenticated={onAuthenticated} />,
    );
    act(() => { lastTerminalProps!.onExit!({ exitCode: 1 }); });
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
