// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AgentPicker } from '../shared/AgentPicker';

afterEach(() => { cleanup(); });

describe('AgentPicker', () => {
  it('renders both options with the current value marked as selected', () => {
    render(<AgentPicker value="claude" onChange={() => {}} />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    // Claude is selected; Codex isn't.
    const claude = screen.getByRole('radio', { name: 'Claude' });
    const codex = screen.getByRole('radio', { name: 'Codex' });
    expect(claude.getAttribute('aria-checked')).toBe('true');
    expect(codex.getAttribute('aria-checked')).toBe('false');
  });

  it('fires onChange with the new agent when an unselected option is clicked', () => {
    const onChange = vi.fn();
    render(<AgentPicker value="claude" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
    expect(onChange).toHaveBeenCalledWith('codex');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onChange when the already-selected option is clicked', () => {
    // Avoids no-op state churn when the user clicks the active pill.
    const onChange = vi.fn();
    render(<AgentPicker value="codex" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('disables both buttons when `disabled` is true', () => {
    const onChange = vi.fn();
    render(<AgentPicker value="claude" onChange={onChange} disabled />);
    const claude = screen.getByRole('radio', { name: 'Claude' }) as HTMLButtonElement;
    const codex = screen.getByRole('radio', { name: 'Codex' }) as HTMLButtonElement;
    expect(claude.disabled).toBe(true);
    expect(codex.disabled).toBe(true);
    fireEvent.click(codex);
    expect(onChange).not.toHaveBeenCalled();
  });
});
