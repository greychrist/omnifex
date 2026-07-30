// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render as rtlRender, screen, cleanup, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip-modern';
import { ContextTimelineToggle } from '../ContextTimelineToggle';

afterEach(() => {
  cleanup();
});

// The toggle renders inside AgentSession's TooltipProvider (AgentSession.tsx:2162).
const render = (ui: React.ReactElement) => {
  const result = rtlRender(<TooltipProvider>{ui}</TooltipProvider>);
  return {
    ...result,
    rerender: (next: React.ReactElement) =>
      result.rerender(<TooltipProvider>{next}</TooltipProvider>),
  };
};

const button = () => screen.getByRole('button', { name: /context timeline/i });

describe('ContextTimelineToggle', () => {
  it('reports its state to assistive tech', () => {
    const { rerender } = render(<ContextTimelineToggle active={false} onToggle={() => {}} />);
    expect(button()).toHaveAttribute('aria-pressed', 'false');
    rerender(<ContextTimelineToggle active onToggle={() => {}} />);
    expect(button()).toHaveAttribute('aria-pressed', 'true');
  });

  // The rail sits in the transcript's left gutter; a control that looks
  // identical on and off gives no clue which state you're in.
  it('is visually distinct when active', () => {
    const { rerender } = render(<ContextTimelineToggle active={false} onToggle={() => {}} />);
    const off = button().className;
    rerender(<ContextTimelineToggle active onToggle={() => {}} />);
    expect(button().className).not.toBe(off);
    expect(button().className).toMatch(/bg-primary/);
  });

  it('names the action it will perform', () => {
    const { rerender } = render(<ContextTimelineToggle active={false} onToggle={() => {}} />);
    expect(button()).toHaveAccessibleName(/show context timeline/i);
    rerender(<ContextTimelineToggle active onToggle={() => {}} />);
    expect(button()).toHaveAccessibleName(/hide context timeline/i);
  });

  it('toggles on click', () => {
    const onToggle = vi.fn();
    render(<ContextTimelineToggle active={false} onToggle={onToggle} />);
    fireEvent.click(button());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
