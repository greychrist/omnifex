// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { SessionHeaderResizeHandle } from '@/components/SessionHeaderResizeHandle';

afterEach(() => { cleanup(); });

const handle = () => screen.getByRole('separator');
const grip = () => screen.getByTestId('header-resize-grip');

describe('SessionHeaderResizeHandle', () => {
  describe('affordance', () => {
    // The old handle was a 2px hairline with no grip — findable only by
    // knowing it was there.
    it('renders a visible grip, not just a hit area', () => {
      render(<SessionHeaderResizeHandle resizing={false} />);
      expect(grip()).toBeTruthy();
    });

    it('keeps a hit area taller than the grip it contains', () => {
      render(<SessionHeaderResizeHandle resizing={false} />);
      expect(handle().className).toMatch(/\bh-2\b/);
      expect(handle().className).toContain('cursor-ns-resize');
    });

    it('stays reachable as a separator with a label', () => {
      render(<SessionHeaderResizeHandle resizing={false} />);
      expect(handle().getAttribute('aria-orientation')).toBe('horizontal');
      expect(handle().getAttribute('aria-label')).toMatch(/resize/i);
    });
  });

  describe('drag state', () => {
    it('marks itself as resizing so the assembly can light its border', () => {
      render(<SessionHeaderResizeHandle resizing />);
      expect(handle().getAttribute('data-resizing')).toBe('true');
    });

    it('carries no resizing marker at rest', () => {
      render(<SessionHeaderResizeHandle resizing={false} />);
      expect(handle().getAttribute('data-resizing')).toBeNull();
    });

    it('holds the grip lit while dragging, not only while hovered', () => {
      const { rerender } = render(<SessionHeaderResizeHandle resizing={false} />);
      const idle = grip().className;
      rerender(<SessionHeaderResizeHandle resizing />);
      expect(grip().className).not.toBe(idle);
    });
  });

  describe('interaction', () => {
    it('starts a resize on pointer down', () => {
      const onPointerDown = vi.fn();
      render(<SessionHeaderResizeHandle resizing={false} onPointerDown={onPointerDown} />);
      fireEvent.pointerDown(handle());
      expect(onPointerDown).toHaveBeenCalledOnce();
    });

    it('resets on double click', () => {
      const onDoubleClick = vi.fn();
      render(<SessionHeaderResizeHandle resizing={false} onDoubleClick={onDoubleClick} />);
      fireEvent.doubleClick(handle());
      expect(onDoubleClick).toHaveBeenCalledOnce();
    });

    it('mentions double-click to reset only once a custom height exists', () => {
      const { rerender } = render(<SessionHeaderResizeHandle resizing={false} canReset={false} />);
      expect(handle().getAttribute('title')).not.toMatch(/double-click/i);
      rerender(<SessionHeaderResizeHandle resizing={false} canReset />);
      expect(handle().getAttribute('title')).toMatch(/double-click/i);
    });
  });
});
