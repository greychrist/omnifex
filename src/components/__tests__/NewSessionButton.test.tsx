// @vitest-environment jsdom
import * as React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react';
import { TooltipProvider } from '../ui/tooltip-modern';
import { NewSessionButton } from '../NewSessionButton';

afterEach(() => { cleanup(); });

// The header wraps everything in a TooltipProvider; so must the tests.
const renderIn = (node: React.ReactNode) => render(<TooltipProvider>{node}</TooltipProvider>);
const button = (): HTMLButtonElement => screen.getByRole('button', { name: /new session/i });

describe('NewSessionButton', () => {
  it('starts a new session when pressed', () => {
    const onClick = vi.fn();
    renderIn(<NewSessionButton onClick={onClick} />);
    fireEvent.click(button());
    expect(onClick).toHaveBeenCalledOnce();
  });

  // The back button's styled tooltip, not the browser's native title.
  it('shows a tooltip like the back button\'s', async () => {
    renderIn(<NewSessionButton onClick={vi.fn()} />);
    expect(button().hasAttribute('title')).toBe(false);
    act(() => { button().focus(); });
    expect((await screen.findByRole('tooltip')).textContent).toBe('Close this session and open a new one');
  });

  it('is disabled when told to', () => {
    const onClick = vi.fn();
    renderIn(<NewSessionButton onClick={onClick} disabled reason="Wait for the current turn to finish" />);
    expect(button().disabled).toBe(true);
    fireEvent.click(button());
    expect(onClick).not.toHaveBeenCalled();
  });

  // A disabled button fires no pointer events, so the tooltip hangs off a
  // wrapper — or the reason it is disabled could never be read.
  it('keeps its tooltip reachable while disabled', async () => {
    renderIn(<NewSessionButton onClick={vi.fn()} disabled reason="Wait for the current turn to finish" />);
    const trigger = button().parentElement!;
    expect(trigger.tagName).toBe('SPAN');
    expect(trigger.getAttribute('data-state')).toBe('closed');
    act(() => { trigger.focus(); });
    expect((await screen.findByRole('tooltip')).textContent).toBe('Wait for the current turn to finish');
  });

  // It sits beside the back button, so it takes that button's size.
  it('matches the back button\'s size', () => {
    renderIn(<NewSessionButton onClick={vi.fn()} />);
    expect(button().className).toMatch(/(^|\s)h-7(\s|$)/);
    expect(button().className).toMatch(/(^|\s)w-7(\s|$)/);
  });
});
