// @vitest-environment jsdom
import React, { useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSplitWidth } from '@/hooks/useSplitWidth';

const KEY = 'omnifex.split.test';

/** A container of a known width, so the clamp has something real to clamp to. */
function Harness({ defaultWidth = 400 }: { defaultWidth?: number }): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width, startResize } = useSplitWidth({
    storageKey: KEY,
    defaultWidth,
    min: 200,
    minRight: 300,
    containerRef,
  });
  return (
    <div ref={containerRef} data-testid="container">
      <div data-testid="left" style={{ width }} />
      <div role="separator" aria-label="Resize" onMouseDown={startResize} />
      <div data-testid="right" />
    </div>
  );
}

function drag(from: number, to: number): void {
  fireEvent.mouseDown(screen.getByRole('separator'), { clientX: from });
  fireEvent.mouseMove(window, { clientX: to });
  fireEvent.mouseUp(window);
}

describe('useSplitWidth', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // jsdom reports every rect as zero, which would clamp the max to a
    // negative number and make every assertion below meaningless.
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: 1000, height: 600, top: 0, left: 0, right: 1000, bottom: 600 }),
    });
  });
  afterEach(() => { cleanup(); });

  it('widens the left pane by the distance dragged', () => {
    render(<Harness />);
    drag(500, 600);
    expect(screen.getByTestId('left').style.width).toBe('500px');
  });

  it('narrows it when dragged the other way', () => {
    render(<Harness />);
    drag(500, 420);
    expect(screen.getByTestId('left').style.width).toBe('320px');
  });

  /**
   * Without a floor the handle can be dragged past the left edge, leaving a
   * table too narrow to read and a handle too far left to grab back.
   */
  it('never shrinks the left pane below its minimum', () => {
    render(<Harness />);
    drag(500, 0);
    expect(screen.getByTestId('left').style.width).toBe('200px');
  });

  /**
   * The ceiling is the container's width minus the room the right pane needs.
   * A splitter that can swallow the pane it exists to reveal is a splitter
   * that can hide the note you just clicked.
   */
  it('never grows past the room the right pane needs', () => {
    render(<Harness />);
    drag(500, 5000);
    expect(screen.getByTestId('left').style.width).toBe('700px');
  });

  it('remembers the width across a remount', () => {
    const { unmount } = render(<Harness />);
    drag(500, 600);
    unmount();
    render(<Harness />);
    expect(screen.getByTestId('left').style.width).toBe('500px');
  });

  /** A stored width from a wider window must still respect this one's ceiling. */
  it('clamps a stored width that no longer fits', () => {
    window.localStorage.setItem(KEY, '5000');
    render(<Harness />);
    expect(screen.getByTestId('left').style.width).toBe('700px');
  });
});
