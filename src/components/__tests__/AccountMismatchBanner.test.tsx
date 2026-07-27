// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { AccountMismatch } from '@/lib/api';
import { AccountMismatchBanner } from '../AccountMismatchBanner';

afterEach(() => {
  cleanup();
});

const MISMATCH: AccountMismatch = {
  expected: 'work@example.com',
  detected: 'personal@example.com',
  configDir: '/tmp/.claude-personal',
  source: 'oauth-file',
};

describe('AccountMismatchBanner', () => {
  it('names both the expected and the detected account', () => {
    render(<AccountMismatchBanner mismatch={MISMATCH} onDismiss={() => {}} />);
    expect(screen.getByText(/work@example\.com/)).toBeTruthy();
    expect(screen.getByText(/personal@example\.com/)).toBeTruthy();
  });

  it('says "not signed in" when nothing was detected', () => {
    render(
      <AccountMismatchBanner
        mismatch={{ ...MISMATCH, detected: null }}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(/not signed in/i)).toBeTruthy();
  });

  it('calls onDismiss when dismissed', () => {
    const onDismiss = vi.fn();
    render(<AccountMismatchBanner mismatch={MISMATCH} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // The restart button only appears when restarting would actually change
  // something — i.e. the running CLI holds the wrong credentials.
  it('offers Restart session when a restart is needed', () => {
    const onRestart = vi.fn();
    render(
      <AccountMismatchBanner mismatch={MISMATCH} onDismiss={() => {}} onRestart={onRestart} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /restart session/i }));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('hides Restart session when the session does not need one', () => {
    // The expectation was corrected; the running session was always fine.
    render(<AccountMismatchBanner mismatch={MISMATCH} onDismiss={() => {}} onRestart={null} />);
    expect(screen.queryByRole('button', { name: /restart session/i })).toBeNull();
    // Dismiss stays available regardless.
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeTruthy();
  });

  it('disables the restart button while a restart is in flight', () => {
    render(
      <AccountMismatchBanner
        mismatch={MISMATCH}
        onDismiss={() => {}}
        onRestart={() => {}}
        restarting
      />,
    );
    const btn = screen.getByRole('button', { name: /restarting/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders nothing when there is no mismatch', () => {
    const { container } = render(
      <AccountMismatchBanner mismatch={null} onDismiss={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
