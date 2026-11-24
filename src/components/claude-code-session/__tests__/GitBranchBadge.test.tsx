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
    render(<GitBranchBadge {...base} changed={0} untracked={0} onViewChanges={vi.fn()} />);
    openPopover();
    expect(screen.queryByRole('button', { name: /view changes/i })).toBeNull();
  });
});

describe('GitBranchBadge — bar size', () => {
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

describe('GitBranchBadge — long names', () => {
  it('cuts a long branch name short on the chip, keeping it whole in the tooltip', () => {
    render(<GitBranchBadge {...base} name="feature/JIRA-1234-a-really-long-branch-name" />);
    const label = screen.getByText('feature/JIRA-1234-a-really-long-branch-name', { selector: 'button span' });
    expect(label.className).toContain('truncate');
    expect(label.className).toContain('max-w-[24ch]');
    expect(screen.getByRole('button').getAttribute('title')).toContain('feature/JIRA-1234-a-really-long-branch-name');
  });
});

describe('GitBranchBadge — icon', () => {
  it('shows a branch by default and takes another icon when given', async () => {
    const { FolderGit2 } = await import('lucide-react');
    const { unmount } = render(<GitBranchBadge {...base} />);
    expect(screen.getByRole('button').querySelector('svg')!.getAttribute('class')).toContain('lucide-git-branch');
    unmount();
    render(<GitBranchBadge {...base} icon={FolderGit2} />);
    expect(screen.getByRole('button').querySelector('svg')!.getAttribute('class')).toContain('lucide-folder-git-2');
  });
});

describe('GitBranchBadge — icon', () => {
  it('draws the icon bare, in the chip\'s own color', () => {
    render(<GitBranchBadge {...base} />);
    const svg = screen.getByRole('button').querySelector('svg')!;
    expect(svg.parentElement!.tagName).toBe('BUTTON');
    expect(svg.getAttribute('class')).not.toContain('text-white');
  });
});

describe('GitBranchBadge — text variant', () => {
  it('drops the chip: no border or fill, the branch color on the text alone', () => {
    render(<GitBranchBadge {...base} color="#ff0000" isTrunk={false} variant="text" />);
    const b = screen.getByRole('button');
    expect(b.className).not.toMatch(/(^|\s)(border|rounded)(\s|$)/);
    const style = b.getAttribute('style') ?? '';
    expect(style).toContain('rgb(255, 0, 0)');
    expect(style).not.toContain('background');
    expect(style).not.toContain('border');
  });

  it('sets the counts right after the name, with no rule between them', () => {
    render(<GitBranchBadge {...base} variant="text" />);
    const b = screen.getByRole('button');
    expect(b.querySelector('.w-px')).toBeNull();
  });

  it('holds both counts in one small badge', () => {
    render(<GitBranchBadge {...base} variant="text" />);
    const badge = screen.getByTestId('change-counts');
    expect(badge.className).toContain('rounded-sm');
    expect(badge.className).toMatch(/(^|\s)bg-/);
    expect(badge.textContent).toBe('21');
  });

  // The color carries `!`: the global `* { border-color }` reset outranks layered
  // border-color utilities.
  it('outlines the count badge', () => {
    render(<GitBranchBadge {...base} variant="text" />);
    const cls = screen.getByTestId('change-counts').className.split(' ');
    expect(cls).toContain('border');
    expect(cls.some((c) => /^border-foreground\/\d+!$/.test(c))).toBe(true);
  });

  it('shows no count badge for a clean checkout', () => {
    render(<GitBranchBadge {...base} changed={0} untracked={0} variant="text" />);
    expect(screen.queryByTestId('change-counts')).toBeNull();
  });

  it('keeps the rule between name and counts on a chip', () => {
    render(<GitBranchBadge {...base} />);
    expect(screen.getByRole('button').querySelector('.w-px')).not.toBeNull();
  });

  it('draws a trunk branch in the bar\'s own text color rather than a black chip', () => {
    render(<GitBranchBadge {...base} variant="text" />);
    const b = screen.getByRole('button');
    expect(b.className).not.toContain('bg-black');
    expect(b.getAttribute('style') ?? '').toBe('');
  });
});

describe('GitBranchBadge — popover', () => {
  it('heads the counts "Changes"', () => {
    render(<GitBranchBadge {...base} />);
    openPopover();
    expect(screen.getByText('Changes')).toBeTruthy();
    expect(screen.queryByText(/working tree/i)).toBeNull();
  });
});

