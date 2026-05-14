// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, { useRef, useState } from 'react';
import { useFindInChat } from '../useFindInChat';

// A small harness that wires the hook to DOM-visible state so we can assert
// from outside without dealing with React state directly. Each test renders
// a fresh harness with its own `content` slot — the contents are what the
// walker searches over.
function Harness({
  initialQuery = '',
  initialOpen = true,
  content,
}: {
  initialQuery?: string;
  initialOpen?: boolean;
  content: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [isOpen, setOpen] = useState(initialOpen);
  const [version, setVersion] = useState(0);
  const { count, activeIndex, next, prev } = useFindInChat({
    containerRef,
    query,
    isOpen,
    transcriptVersion: version,
  });
  return (
    <div>
      <button data-testid="set-query-hello" onClick={() => { setQuery('hello'); }}>q-hello</button>
      <button data-testid="set-query-empty" onClick={() => { setQuery(''); }}>q-empty</button>
      <button data-testid="set-query-foo" onClick={() => { setQuery('foo'); }}>q-foo</button>
      <button data-testid="close" onClick={() => { setOpen(false); }}>close</button>
      <button data-testid="bump-version" onClick={() => { setVersion((v) => v + 1); }}>bump</button>
      <button data-testid="next" onClick={next}>next</button>
      <button data-testid="prev" onClick={prev}>prev</button>
      <span data-testid="count">{count}</span>
      <span data-testid="active">{activeIndex}</span>
      <div data-testid="container" ref={containerRef}>
        {content}
      </div>
    </div>
  );
}

function flush() {
  // Advance past the hook's internal debounce. Two ticks because state
  // updates from useEffect → setState may schedule another microtask.
  act(() => {
    vi.advanceTimersByTime(250);
  });
}

describe('useFindInChat', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('finds nothing for an empty query', () => {
    vi.useFakeTimers();
    render(<Harness initialQuery="" content={<p>Hello world</p>} />);
    flush();
    expect(screen.getByTestId('count').textContent).toBe('0');
    expect(
      screen.getByTestId('container').querySelectorAll('mark[data-find]'),
    ).toHaveLength(0);
  });

  it('counts case-insensitive substring matches and wraps each in a <mark data-find>', () => {
    vi.useFakeTimers();
    render(
      <Harness
        initialQuery="hello"
        content={<p>Hello world. Say HELLO again, hello!</p>}
      />,
    );
    flush();
    expect(screen.getByTestId('count').textContent).toBe('3');
    const marks = screen
      .getByTestId('container')
      .querySelectorAll('mark[data-find]');
    expect(marks).toHaveLength(3);
    marks.forEach((m) => { expect(m.textContent?.toLowerCase()).toBe('hello'); });
  });

  it('keeps exactly one <mark> with .is-active at a time', () => {
    vi.useFakeTimers();
    render(
      <Harness initialQuery="x" content={<p>x x x</p>} />,
    );
    flush();
    const container = screen.getByTestId('container');
    expect(container.querySelectorAll('mark[data-find]')).toHaveLength(3);
    expect(container.querySelectorAll('mark[data-find].is-active')).toHaveLength(1);
  });

  it('next() advances and wraps around past the end', () => {
    vi.useFakeTimers();
    render(<Harness initialQuery="x" content={<p>x y x y x</p>} />);
    flush();
    expect(screen.getByTestId('count').textContent).toBe('3');
    expect(screen.getByTestId('active').textContent).toBe('0');
    act(() => { fireEvent.click(screen.getByTestId('next')); });
    expect(screen.getByTestId('active').textContent).toBe('1');
    act(() => { fireEvent.click(screen.getByTestId('next')); });
    expect(screen.getByTestId('active').textContent).toBe('2');
    act(() => { fireEvent.click(screen.getByTestId('next')); });
    expect(screen.getByTestId('active').textContent).toBe('0'); // wrap
  });

  it('prev() retreats and wraps around past the beginning', () => {
    vi.useFakeTimers();
    render(<Harness initialQuery="x" content={<p>x y x y x</p>} />);
    flush();
    expect(screen.getByTestId('active').textContent).toBe('0');
    act(() => { fireEvent.click(screen.getByTestId('prev')); });
    expect(screen.getByTestId('active').textContent).toBe('2'); // wrap to last
    act(() => { fireEvent.click(screen.getByTestId('prev')); });
    expect(screen.getByTestId('active').textContent).toBe('1');
  });

  it('changing the query re-walks and unwraps stale marks', () => {
    vi.useFakeTimers();
    render(
      <Harness
        initialQuery="hello"
        content={
          <div>
            <p>Hello world</p>
            <p>foo bar foo</p>
          </div>
        }
      />,
    );
    flush();
    expect(screen.getByTestId('count').textContent).toBe('1');
    act(() => { fireEvent.click(screen.getByTestId('set-query-foo')); });
    flush();
    expect(screen.getByTestId('count').textContent).toBe('2');
    const marks = screen
      .getByTestId('container')
      .querySelectorAll('mark[data-find]');
    expect(marks).toHaveLength(2);
    marks.forEach((m) => { expect(m.textContent).toBe('foo'); });
  });

  it('clears all marks when query becomes empty', () => {
    vi.useFakeTimers();
    render(<Harness initialQuery="hello" content={<p>Hello world</p>} />);
    flush();
    expect(screen.getByTestId('count').textContent).toBe('1');
    act(() => { fireEvent.click(screen.getByTestId('set-query-empty')); });
    flush();
    expect(screen.getByTestId('count').textContent).toBe('0');
    expect(
      screen.getByTestId('container').querySelectorAll('mark[data-find]'),
    ).toHaveLength(0);
  });

  it('clears all marks when closed', () => {
    vi.useFakeTimers();
    render(<Harness initialQuery="hello" content={<p>Hello world</p>} />);
    flush();
    expect(screen.getByTestId('count').textContent).toBe('1');
    act(() => { fireEvent.click(screen.getByTestId('close')); });
    flush();
    expect(screen.getByTestId('count').textContent).toBe('0');
    expect(
      screen.getByTestId('container').querySelectorAll('mark[data-find]'),
    ).toHaveLength(0);
  });

  it('skips nodes under an ancestor with data-find-skip', () => {
    vi.useFakeTimers();
    render(
      <Harness
        initialQuery="hello"
        content={
          <div>
            <p>Hello world</p>
            <div data-find-skip>
              <p>Hello inside skip — should be ignored</p>
              <p>nested hello also ignored</p>
            </div>
          </div>
        }
      />,
    );
    flush();
    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  it('does not match text inside hidden elements', () => {
    // The DOM walker should bail on display:none / visibility:hidden ancestors.
    // Build a fixture where one of two matches is hidden.
    vi.useFakeTimers();
    render(
      <Harness
        initialQuery="hello"
        content={
          <div>
            <p>Hello visible</p>
            <p style={{ display: 'none' }}>Hello hidden</p>
          </div>
        }
      />,
    );
    flush();
    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  it('preserves activeIndex across a re-walk when still in range', () => {
    vi.useFakeTimers();
    render(<Harness initialQuery="x" content={<p>x x x</p>} />);
    flush();
    act(() => { fireEvent.click(screen.getByTestId('next')); });
    expect(screen.getByTestId('active').textContent).toBe('1');
    // Trigger a content-driven re-walk by bumping the version. Content unchanged,
    // so match set is identical — active should stay at 1.
    act(() => { fireEvent.click(screen.getByTestId('bump-version')); });
    flush();
    expect(screen.getByTestId('count').textContent).toBe('3');
    expect(screen.getByTestId('active').textContent).toBe('1');
  });

  it('clamps activeIndex to 0 when the new match set is shorter', () => {
    // Start with a 3-match fixture, advance to index 2, then change the query
    // to one with only 1 match.
    vi.useFakeTimers();
    render(
      <Harness
        initialQuery="x"
        content={
          <div>
            <p>x x x</p>
            <p>foo</p>
          </div>
        }
      />,
    );
    flush();
    act(() => { fireEvent.click(screen.getByTestId('next')); });
    act(() => { fireEvent.click(screen.getByTestId('next')); });
    expect(screen.getByTestId('active').textContent).toBe('2');
    act(() => { fireEvent.click(screen.getByTestId('set-query-foo')); });
    flush();
    expect(screen.getByTestId('count').textContent).toBe('1');
    expect(screen.getByTestId('active').textContent).toBe('0');
  });
});
