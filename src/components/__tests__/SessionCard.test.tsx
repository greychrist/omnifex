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
