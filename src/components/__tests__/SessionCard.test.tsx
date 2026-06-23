// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SessionCard } from '../SessionCard';
import type { SessionContextUsage } from '@/lib/api';

afterEach(() => { cleanup(); });

const USAGE: SessionContextUsage = {
  totalTokens: 12_000,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  percentage: 6,
  model: 'sonnet',
  categories: [],
};

describe('SessionCard — context popover controls', () => {
  it('renders the injected session controls inside the context popover', () => {
    render(
      <SessionCard
        totalTokens={12_000}
        model="sonnet"
        contextUsage={USAGE}
        sessionStatus="active"
        controls={<div data-testid="session-controls" />}
      />,
    );

    // Closed: controls are not in the document.
    expect(screen.queryByTestId('session-controls')).toBeNull();

    // Open the context popover via its trigger (shows the token count).
    fireEvent.click(screen.getByText('12.0k'));
    expect(screen.getByTestId('session-controls')).toBeTruthy();
    expect(screen.getByText('Context window')).toBeTruthy();
  });

  it('sizes a 1M Account-Default session against 1M in the client-side fallback', () => {
    // The reported bug: a resumed chat-mode "Account Default" session (history
    // loaded statically, so live contextUsage hasn't been fetched) whose own
    // model string carries no [1m] suffix. Without the account default it was
    // pinned to 200k → 181.9k read as 91%. With the account default ("opus[1m]")
    // the gauge sizes against 1M → ~18%.
    render(
      <SessionCard
        totalTokens={181_886}
        model="claude-opus-4-8"
        defaultModel="opus[1m]"
        sessionStatus="active"
      />,
    );
    expect(screen.getByText('18%')).toBeTruthy();
    expect(screen.queryByText('91%')).toBeNull();
  });

  it('still pins to 200k when no live usage and no 1M account default (regression guard)', () => {
    render(
      <SessionCard
        totalTokens={181_886}
        model="claude-opus-4-8"
        sessionStatus="active"
      />,
    );
    expect(screen.getByText('91%')).toBeTruthy();
  });

  it('renders no controls section when none are provided', () => {
    render(
      <SessionCard
        totalTokens={12_000}
        model="sonnet"
        contextUsage={USAGE}
        sessionStatus="active"
      />,
    );
    fireEvent.click(screen.getByText('12.0k'));
    expect(screen.queryByTestId('session-controls')).toBeNull();
    expect(screen.getByText('Context window')).toBeTruthy();
  });
});
