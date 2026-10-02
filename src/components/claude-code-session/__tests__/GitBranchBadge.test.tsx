// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

import { GitBranchBadge } from '@/components/claude-code-session/GitBranchBadge';

afterEach(() => { cleanup(); });

const base = {
  name: 'main',
  changed: 2,
  untracked: 1,
  color: null,
  isTrunk: true,
  path: '/repo',
};

function openPopover() {
  // The badge is only a popover trigger when `path` is supplied.
  fireEvent.click(screen.getByRole('button', { name: /main/i }));
}

describe('GitBranchBadge — view changes', () => {
  it('offers to open the diff viewer when a handler is supplied', () => {
    render(<GitBranchBadge {...base} onViewChanges={vi.fn()} />);
    openPopover();
    expect(screen.getByRole('button', { name: /view changes/i })).toBeTruthy();
  });

  it('calls the handler when pressed', () => {
    const onViewChanges = vi.fn();
    render(<GitBranchBadge {...base} onViewChanges={onViewChanges} />);
    openPopover();
    fireEvent.click(screen.getByRole('button', { name: /view changes/i }));
    expect(onViewChanges).toHaveBeenCalled();
  });

  it('offers nothing when no handler is supplied', () => {
    render(<GitBranchBadge {...base} />);
    openPopover();
    expect(screen.queryByRole('button', { name: /view changes/i })).toBeNull();
  });

  it('offers nothing when the working tree is clean', () => {
    // Nothing to diff — the control would open an empty viewer.
    render(<GitBranchBadge {...base} changed={0} untracked={0} onViewChanges={vi.fn()} />);
    openPopover();
    expect(screen.queryByRole('button', { name: /view changes/i })).toBeNull();
  });
});

describe('GitBranchBadge — bar size', () => {
  // On a status bar the badge keeps its chip, at the bar's 10px type.
  it('takes the status bar\'s text size, keeping its chip', () => {
    render(<GitBranchBadge {...base} size="bar" />);
    const chip = screen.getByRole('button', { name: /main/i });
    expect(chip.className).toContain('text-[10px]');
    expect(chip.className).not.toContain('text-[11px]');
    expect(chip.className).toContain('rounded');
    expect(chip.className).toContain('border');
  });

  it('keeps the header size by default', () => {
    render(<GitBranchBadge {...base} />);
    expect(screen.getByRole('button', { name: /main/i }).className).toContain('text-[11px]');
  });
});
