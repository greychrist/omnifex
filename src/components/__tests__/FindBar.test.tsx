// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FindBar } from '../FindBar';

const baseProps = {
  query: '',
  onQueryChange: vi.fn(),
  count: 0,
  activeIndex: 0,
  onNext: vi.fn(),
  onPrev: vi.fn(),
  onClose: vi.fn(),
};

describe('FindBar', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('carries data-find-skip on its root so the walker ignores its own DOM', () => {
    const { container } = render(<FindBar {...baseProps} />);
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root!.hasAttribute('data-find-skip')).toBe(true);
  });

  it('shows 0/0 when there are no matches', () => {
    render(<FindBar {...baseProps} count={0} activeIndex={0} />);
    expect(screen.getByTestId('find-count').textContent).toBe('0/0');
  });

  it('shows activeIndex+1 / count when matches exist', () => {
    render(<FindBar {...baseProps} count={5} activeIndex={2} />);
    expect(screen.getByTestId('find-count').textContent).toBe('3/5');
  });

  it('disables prev/next when count is zero', () => {
    render(<FindBar {...baseProps} count={0} />);
    expect((screen.getByTestId('find-next')).disabled).toBe(true);
    expect((screen.getByTestId('find-prev')).disabled).toBe(true);
  });

  it('enables prev/next when count > 0', () => {
    render(<FindBar {...baseProps} count={1} />);
    expect((screen.getByTestId('find-next')).disabled).toBe(false);
    expect((screen.getByTestId('find-prev')).disabled).toBe(false);
  });

  it('calls onQueryChange when the input changes', () => {
    const onQueryChange = vi.fn();
    render(<FindBar {...baseProps} onQueryChange={onQueryChange} />);
    fireEvent.change(screen.getByTestId('find-input'), { target: { value: 'hi' } });
    expect(onQueryChange).toHaveBeenCalledWith('hi');
  });

  it('Enter on the input fires onNext', () => {
    const onNext = vi.fn();
    render(<FindBar {...baseProps} count={1} onNext={onNext} />);
    fireEvent.keyDown(screen.getByTestId('find-input'), { key: 'Enter' });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('Shift+Enter on the input fires onPrev', () => {
    const onPrev = vi.fn();
    render(<FindBar {...baseProps} count={1} onPrev={onPrev} />);
    fireEvent.keyDown(screen.getByTestId('find-input'), {
      key: 'Enter',
      shiftKey: true,
    });
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it('Escape on the input fires onClose', () => {
    const onClose = vi.fn();
    render(<FindBar {...baseProps} onClose={onClose} />);
    fireEvent.keyDown(screen.getByTestId('find-input'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the close button fires onClose', () => {
    const onClose = vi.fn();
    render(<FindBar {...baseProps} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('find-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking next / prev buttons fires their handlers', () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    render(<FindBar {...baseProps} count={3} onNext={onNext} onPrev={onPrev} />);
    fireEvent.click(screen.getByTestId('find-next'));
    fireEvent.click(screen.getByTestId('find-prev'));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it('does not fire next/prev on Enter when count is zero', () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    render(<FindBar {...baseProps} count={0} onNext={onNext} onPrev={onPrev} />);
    fireEvent.keyDown(screen.getByTestId('find-input'), { key: 'Enter' });
    fireEvent.keyDown(screen.getByTestId('find-input'), {
      key: 'Enter',
      shiftKey: true,
    });
    expect(onNext).not.toHaveBeenCalled();
    expect(onPrev).not.toHaveBeenCalled();
  });
});
