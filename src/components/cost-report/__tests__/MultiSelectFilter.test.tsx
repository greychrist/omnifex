// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MultiSelectFilter } from '../MultiSelectFilter';

const OPTIONS = ['/Users/me/alpha', '/Users/me/beta', '/Users/me/gamma'];

function open(label = 'Projects') {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(label, 'i') }));
}

describe('MultiSelectFilter', () => {
  afterEach(cleanup);

  // The convention the whole filter bar depends on: no selection means "show
  // everything", so the button must say so rather than reading as a
  // zero-result state.
  it('summarises an empty selection as "All <label>"', () => {
    render(<MultiSelectFilter label="Projects" options={OPTIONS} selected={[]} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /All projects/i })).toBeTruthy();
  });

  it('names the single selection, and counts beyond one', () => {
    const { rerender } = render(
      <MultiSelectFilter label="Projects" options={OPTIONS} selected={['/Users/me/alpha']} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /\/Users\/me\/alpha/ })).toBeTruthy();
    rerender(
      <MultiSelectFilter label="Projects" options={OPTIONS} selected={OPTIONS.slice(0, 2)} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /2 projects/i })).toBeTruthy();
  });

  it('adds a value on click and removes it on a second click', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <MultiSelectFilter label="Projects" options={OPTIONS} selected={[]} onChange={onChange} />,
    );
    open();
    fireEvent.click(screen.getByTitle('/Users/me/beta'));
    expect(onChange).toHaveBeenCalledWith(['/Users/me/beta']);

    onChange.mockClear();
    rerender(
      <MultiSelectFilter label="Projects" options={OPTIONS} selected={['/Users/me/beta']} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTitle('/Users/me/beta'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('clears back to empty, which means all', () => {
    const onChange = vi.fn();
    render(
      <MultiSelectFilter label="Models" options={OPTIONS} selected={OPTIONS} onChange={onChange} />,
    );
    open('3 models');
    fireEvent.click(screen.getByText(/Clear \(3\)/));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('filters the list when searchable, and says so when nothing matches', () => {
    render(
      <MultiSelectFilter label="Projects" options={OPTIONS} selected={[]} onChange={vi.fn()} searchable />,
    );
    open();
    const box = screen.getByPlaceholderText('Filter projects…');
    fireEvent.change(box, { target: { value: 'bet' } });
    expect(screen.queryByTitle('/Users/me/alpha')).toBeNull();
    expect(screen.getByTitle('/Users/me/beta')).toBeTruthy();

    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('shows a shortened label but keeps the full value in the title', () => {
    render(
      <MultiSelectFilter
        label="Projects"
        options={OPTIONS}
        selected={[]}
        onChange={vi.fn()}
        renderOption={(v) => v.split('/').pop()!}
      />,
    );
    open();
    expect(screen.getByTitle('/Users/me/alpha').textContent).toBe('alpha');
  });

  it('closes on click-away without changing the selection', () => {
    const onChange = vi.fn();
    const { container } = render(
      <MultiSelectFilter label="Projects" options={OPTIONS} selected={[]} onChange={onChange} />,
    );
    open();
    expect(screen.getByTitle('/Users/me/alpha')).toBeTruthy();
    fireEvent.click(container.querySelector('.fixed.inset-0')!);
    expect(screen.queryByTitle('/Users/me/alpha')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
