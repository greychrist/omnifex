// @vitest-environment jsdom
import React, { useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useColumnWidths } from '@/hooks/useColumnWidths';

const KEY = 'omnifex.columns.test';
const DEFAULTS = { type: 100, project: 200, updated: 150 };

/**
 * Three sized columns after one flexible one, which is the shape every table
 * that uses this hook has: a name column that fills, then fixed metadata.
 */
function Harness(): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const { widths, startResize, reset } = useColumnWidths({
    storageKey: KEY,
    defaults: DEFAULTS,
    min: 50,
    reserve: 160,
    containerRef,
  });
  return (
    <div ref={containerRef}>
      <span data-testid="type" style={{ width: widths.type }} />
      <span data-testid="project" style={{ width: widths.project }} />
      <span data-testid="updated" style={{ width: widths.updated }} />
      <span
        role="separator"
        aria-label="flex-type"
        onMouseDown={(e) => { startResize(e, { shrink: 'type' }); }}
      />
      <span
        role="separator"
        aria-label="type-project"
        onMouseDown={(e) => { startResize(e, { grow: 'type', shrink: 'project' }); }}
      />
      <span
        role="separator"
        aria-label="project-updated"
        onMouseDown={(e) => { startResize(e, { grow: 'project', shrink: 'updated' }); }}
      />
      <button type="button" onClick={reset}>reset</button>
    </div>
  );
}

function drag(handle: string, from: number, to: number): void {
  fireEvent.mouseDown(screen.getByLabelText(handle), { clientX: from });
  fireEvent.mouseMove(window, { clientX: to });
  fireEvent.mouseUp(window);
}

function widthOf(id: string): string {
  return screen.getByTestId(id).style.width;
}

describe('useColumnWidths', () => {
  beforeEach(() => { window.localStorage.clear(); });
  afterEach(() => { cleanup(); });

  /**
   * The handle beside the flexible column has no partner to grow: the space it
   * frees is absorbed by the column that has no width of its own.
   */
  it('gives space to the flexible column when its boundary is dragged right', () => {
    render(<Harness />);
    drag('flex-type', 300, 340);
    expect(widthOf('type')).toBe('60px');
    expect(widthOf('project')).toBe('200px');
  });

  it('takes space back from the flexible column when dragged left', () => {
    render(<Harness />);
    drag('flex-type', 300, 250);
    expect(widthOf('type')).toBe('150px');
  });

  /**
   * A boundary between two sized columns moves exactly as far as the cursor
   * does: one column gains what the other gives up, so no other boundary on
   * the row shifts underneath the drag.
   */
  it('moves width from one column to its neighbour', () => {
    render(<Harness />);
    drag('type-project', 400, 430);
    expect(widthOf('type')).toBe('130px');
    expect(widthOf('project')).toBe('170px');
  });

  it('never shrinks a column below the minimum', () => {
    render(<Harness />);
    drag('project-updated', 600, 5000);
    expect(widthOf('updated')).toBe('50px');
    // The partner stops growing at the same instant, or the boundary would
    // keep travelling after the column it is pushing has run out of room.
    expect(widthOf('project')).toBe('300px');
  });

  it('never shrinks the growing column below the minimum either', () => {
    render(<Harness />);
    drag('type-project', 400, 0);
    expect(widthOf('type')).toBe('50px');
    expect(widthOf('project')).toBe('250px');
  });

  it('remembers widths across a remount', () => {
    const { unmount } = render(<Harness />);
    drag('type-project', 400, 430);
    unmount();
    render(<Harness />);
    expect(widthOf('type')).toBe('130px');
    expect(widthOf('project')).toBe('170px');
  });

  it('falls back to the defaults when the stored value is junk', () => {
    window.localStorage.setItem(KEY, '{"type":"wide","project":-5}');
    render(<Harness />);
    expect(widthOf('type')).toBe('100px');
    expect(widthOf('project')).toBe('200px');
  });

  it('puts every column back with reset', () => {
    render(<Harness />);
    drag('type-project', 400, 430);
    fireEvent.click(screen.getByText('reset'));
    expect(widthOf('type')).toBe('100px');
    expect(widthOf('project')).toBe('200px');
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  /**
   * Widths saved in a wide window must not squeeze the flexible column out of
   * existence in a narrow one — that column holds the name you navigate by.
   */
  it('clamps stored widths that no longer fit the container', () => {
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: 500, height: 100, top: 0, left: 0, right: 500, bottom: 100 }),
    });
    window.localStorage.setItem(KEY, JSON.stringify({ type: 100, project: 200, updated: 150 }));
    render(<Harness />);
    // 500 less the 160 reserved leaves 340 for 450px of columns. Each gives up
    // a share of the 110px overflow proportional to its room above the 50px
    // minimum, so no single column is emptied to spare the others.
    expect(widthOf('type')).toBe('82px');
    expect(widthOf('project')).toBe('145px');
    expect(widthOf('updated')).toBe('113px');
  });

  /** Below the sum of the minimums there is nothing left to apportion. */
  it('floors every column when the container cannot fit even the minimums', () => {
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: 250, height: 100, top: 0, left: 0, right: 250, bottom: 100 }),
    });
    render(<Harness />);
    expect([widthOf('type'), widthOf('project'), widthOf('updated')])
      .toEqual(['50px', '50px', '50px']);
  });
});
