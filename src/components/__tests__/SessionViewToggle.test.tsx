// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SessionViewToggle } from '../SessionViewToggle';

afterEach(cleanup);

describe('SessionViewToggle', () => {
  it('offers exactly Standard and Expanded', () => {
    render(<SessionViewToggle mode="standard" onChange={() => {}} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Standard', 'Expanded']);
  });

  it('reports the view picked', () => {
    const onChange = vi.fn();
    render(<SessionViewToggle mode="standard" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expanded' }));
    expect(onChange).toHaveBeenCalledWith('expanded');
  });
});
