// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AgentBadge } from '../shared/AgentBadge';
import { TooltipProvider } from '../ui/tooltip-modern';

afterEach(() => { cleanup(); });

// TooltipSimple needs a surrounding TooltipProvider.
function renderBadge(node: React.ReactElement) {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

describe('AgentBadge', () => {
  it('exposes a "Claude" brand icon (role=img) when agent=claude', () => {
    renderBadge(<AgentBadge agent="claude" />);
    expect(screen.getByRole('img', { name: 'Claude' })).toBeTruthy();
  });

  it('exposes an "OpenAI Codex" brand icon when agent=codex', () => {
    renderBadge(<AgentBadge agent="codex" />);
    expect(screen.getByRole('img', { name: 'OpenAI Codex' })).toBeTruthy();
  });

  it('exposes a button with an accessible name when onClick is provided', () => {
    renderBadge(<AgentBadge agent="claude" onClick={() => {}} />);
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
    const button = screen.getByRole<HTMLButtonElement>('button', { name: /claude/i });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders a non-interactive element (no button role) when onClick is absent', () => {
    renderBadge(<AgentBadge agent="codex" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('img', { name: 'OpenAI Codex' })).toBeTruthy();
  });
});
