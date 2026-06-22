// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { CostWidget, formatCost } from '@/components/claude-code-session/CostWidget';

afterEach(() => { cleanup(); });

describe('formatCost', () => {
  it('shows two decimals for normal amounts', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(2.5)).toBe('$2.50');
    expect(formatCost(12.345)).toBe('$12.35');
  });

  it('keeps four decimals for sub-cent amounts so they do not collapse to $0.00', () => {
    expect(formatCost(0.0001)).toBe('$0.0001');
    expect(formatCost(0.0099)).toBe('$0.0099');
  });
});

describe('CostWidget', () => {
  it('renders a placeholder when there is no cost data yet', () => {
    render(<CostWidget costUsd={null} />);
    expect(screen.getByText('—')).toBeTruthy();
    // Placeholder is non-interactive (no button to click).
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders the formatted session cost and fires onClick', () => {
    const onClick = vi.fn();
    render(<CostWidget costUsd={3.5} onClick={onClick} accountName="Acme" />);
    const btn = screen.getByRole('button');
    expect(btn.textContent).toContain('$3.50');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders $0.00 at the start of a session', () => {
    render(<CostWidget costUsd={0} onClick={() => {}} />);
    expect(screen.getByRole('button').textContent).toContain('$0.00');
  });
});
