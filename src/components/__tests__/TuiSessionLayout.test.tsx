// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { forwardRef, useImperativeHandle } from 'react';
import { TooltipProvider } from '../ui/tooltip-modern';
import { TuiSessionLayout } from '../TuiSessionLayout';

function renderInProvider(node: React.ReactNode) {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

// Mock TerminalView with a forwardRef stub that exposes the same imperative
// handle the real component does, so we can verify scroll-to-top / scroll-to-
// bottom button wiring without booting xterm in jsdom.
const scrollToTopSpy = vi.fn();
const scrollToBottomSpy = vi.fn();

vi.mock('../TerminalView', () => ({
  TerminalView: forwardRef<{ scrollToTop: () => void; scrollToBottom: () => void }, { tabId: string }>(
    (props, ref) => {
      useImperativeHandle(ref, () => ({
        scrollToTop: scrollToTopSpy,
        scrollToBottom: scrollToBottomSpy,
      }));
      return <div data-testid="terminal-view" data-tab={props.tabId}>TerminalView</div>;
    },
  ),
}));

afterEach(() => {
  cleanup();
  scrollToTopSpy.mockReset();
  scrollToBottomSpy.mockReset();
});

describe('TuiSessionLayout — single-pane card', () => {
  it('renders the TerminalView (no rendered-chat side-by-side)', () => {
    renderInProvider(<TuiSessionLayout tabId="tab-1" />);
    expect(screen.getByTestId('terminal-view')).toBeTruthy();
  });

  it('exposes scroll-to-top and scroll-to-bottom buttons', () => {
    renderInProvider(<TuiSessionLayout tabId="tab-1" />);
    expect(screen.getByRole('button', { name: /scroll to top/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /scroll to bottom/i })).toBeTruthy();
  });

  it('clicking scroll-to-top calls TerminalView.scrollToTop', () => {
    renderInProvider(<TuiSessionLayout tabId="tab-1" />);
    fireEvent.click(screen.getByRole('button', { name: /scroll to top/i }));
    expect(scrollToTopSpy).toHaveBeenCalledTimes(1);
    expect(scrollToBottomSpy).not.toHaveBeenCalled();
  });

  it('clicking scroll-to-bottom calls TerminalView.scrollToBottom', () => {
    renderInProvider(<TuiSessionLayout tabId="tab-1" />);
    fireEvent.click(screen.getByRole('button', { name: /scroll to bottom/i }));
    expect(scrollToBottomSpy).toHaveBeenCalledTimes(1);
    expect(scrollToTopSpy).not.toHaveBeenCalled();
  });
});
