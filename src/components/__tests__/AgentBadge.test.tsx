// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AgentBadge } from '../shared/AgentBadge';
import { TooltipProvider } from '../ui/tooltip-modern';

afterEach(() => { cleanup(); });

// The badge uses `TooltipSimple` for the hover label, which requires a
// surrounding `TooltipProvider`. Wrap every render with one so the radix
// context is available — matches the production setup, where the
// session header sits inside `<TooltipProvider>` (see AgentSession.tsx).
function renderBadge(node: React.ReactElement) {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

describe('AgentBadge', () => {
  it('renders the "Claude" label when agent=claude', () => {
    renderBadge(<AgentBadge agent="claude" />);
    expect(screen.getByText('Claude')).toBeTruthy();
  });

  it('renders the "Codex" label when agent=codex', () => {
    renderBadge(<AgentBadge agent="codex" />);
    expect(screen.getByText('Codex')).toBeTruthy();
  });

  it('exposes a button with an accessible name when onClick is provided', () => {
    renderBadge(<AgentBadge agent="claude" onClick={() => {}} />);
    // The badge is a <button> so screen readers announce it as an
    // interactive control instead of inert text.
    const button = screen.getByRole('button', { name: /claude/i });
    expect(button).toBeTruthy();
  });

  it('fires onClick when clicked and not disabled', () => {
    const onClick = vi.fn();
    renderBadge(<AgentBadge agent="claude" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: /claude/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onClick when disabled is true', () => {
    const onClick = vi.fn();
    renderBadge(<AgentBadge agent="claude" onClick={onClick} disabled />);
    const button = screen.getByRole('button', { name: /claude/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders a non-interactive element (no button role) when onClick is absent', () => {
    // Codex tabs use the badge as informational only — no click target,
    // no button semantics. The label still has to be present.
    renderBadge(<AgentBadge agent="codex" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Codex')).toBeTruthy();
  });
});
