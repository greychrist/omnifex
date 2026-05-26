// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TuiSessionLayout } from '../TuiSessionLayout';

// TerminalView mounts a real xterm instance against the DOM, which jsdom
// can't satisfy. Stub it with a marker div so we can assert visibility
// without booting the terminal.
vi.mock('../TerminalView', () => ({
  TerminalView: ({ tabId }: { tabId: string }) => (
    <div data-testid="terminal-view" data-tab={tabId}>TerminalView</div>
  ),
}));

const LEGACY_SHOW_STORAGE_KEY = 'omnifex:tui-show-rendered';

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => { cleanup(); });

describe('TuiSessionLayout — rendered-chat toggle', () => {
  it('hides the messages pane by default (TUI is the primary surface)', () => {
    render(
      <TuiSessionLayout
        tabId="tab-1"
        messagesView={<div data-testid="messages-view">messages</div>}
      />,
    );

    expect(screen.getByTestId('terminal-view')).toBeTruthy();
    expect(screen.queryByTestId('messages-view')).toBeNull();
    expect(screen.getByRole('button', { name: /show rendered chat/i })).toBeTruthy();
  });

  it('shows the messages pane when the toggle button is clicked', () => {
    render(
      <TuiSessionLayout
        tabId="tab-1"
        messagesView={<div data-testid="messages-view">messages</div>}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /show rendered chat/i }));
    expect(screen.getByTestId('messages-view')).toBeTruthy();
    expect(screen.getByRole('button', { name: /hide rendered chat/i })).toBeTruthy();
  });

  it('hides the messages pane again when toggled off', () => {
    render(
      <TuiSessionLayout
        tabId="tab-1"
        messagesView={<div data-testid="messages-view">messages</div>}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /show rendered chat/i }));
    fireEvent.click(screen.getByRole('button', { name: /hide rendered chat/i }));
    expect(screen.queryByTestId('messages-view')).toBeNull();
  });

  it('does NOT persist the visible state across mounts (always starts hidden)', () => {
    const { unmount } = render(
      <TuiSessionLayout
        tabId="tab-1"
        messagesView={<div data-testid="messages-view">messages</div>}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /show rendered chat/i }));
    expect(screen.getByTestId('messages-view')).toBeTruthy();

    unmount();

    render(
      <TuiSessionLayout
        tabId="tab-1"
        messagesView={<div data-testid="messages-view">messages</div>}
      />,
    );

    // Fresh mount = fresh "hidden" state, regardless of prior in-session
    // toggling. The terminal is the primary surface every time the user
    // enters TUI mode.
    expect(screen.queryByTestId('messages-view')).toBeNull();
    expect(screen.getByRole('button', { name: /show rendered chat/i })).toBeTruthy();
  });

  it('ignores a stale "true" value left in localStorage by an earlier build', () => {
    // Earlier versions of this component persisted visibility under this
    // key. Existing users may have it set; we now default to hidden.
    localStorage.setItem(LEGACY_SHOW_STORAGE_KEY, 'true');

    render(
      <TuiSessionLayout
        tabId="tab-1"
        messagesView={<div data-testid="messages-view">messages</div>}
      />,
    );

    expect(screen.queryByTestId('messages-view')).toBeNull();
  });
});
