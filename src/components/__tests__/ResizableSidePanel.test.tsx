// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { ResizableSidePanel } from '@/components/ResizableSidePanel';

beforeAll(() => {
  Element.prototype.setPointerCapture ??= function () { /* jsdom */ };
  Element.prototype.releasePointerCapture ??= function () { /* jsdom */ };
});

afterEach(() => { cleanup(); localStorage.clear(); });

const panel = () => screen.getByTestId('resizable-side-panel');
const grip = () => screen.getByRole('separator', { name: /resize/i });

const drag = (dx: number) => {
  const g = grip();
  fireEvent.pointerDown(g, { clientX: 500, clientY: 0, pointerId: 1 });
  fireEvent.pointerMove(g, { clientX: 500 + dx, clientY: 0, pointerId: 1 });
  fireEvent.pointerUp(g, { pointerId: 1 });
};

const setup = (props: Partial<React.ComponentProps<typeof ResizableSidePanel>> = {}) =>
  render(
    <ResizableSidePanel storageKey="omnifex.test.panelWidth" title="Test panel" {...props}>
      <div>body</div>
    </ResizableSidePanel>,
  );

describe('ResizableSidePanel', () => {
  describe('shape', () => {
    it('renders its title and children', () => {
      setup();
      expect(screen.getByText('Test panel')).toBeTruthy();
      expect(screen.getByText('body')).toBeTruthy();
    });

    // It must not run the full height of the chat body — the subagent bar and
    // the composer below it have to stay visible.
    it('fills its container rather than the viewport', () => {
      setup();
      expect(panel().className).toContain('absolute');
      expect(panel().className).toMatch(/\binset-y-0\b/);
      expect(panel().className).toMatch(/\bright-0\b/);
    });

    it('closes when the close button is pressed', () => {
      const onClose = vi.fn();
      setup({ onClose });
      fireEvent.click(screen.getByRole('button', { name: /close/i }));
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  describe('resizing', () => {
    it('widens when the grip is dragged left', () => {
      setup();
      const before = parseInt(panel().style.width, 10);
      drag(-120);
      expect(parseInt(panel().style.width, 10)).toBe(before + 120);
    });

    it('narrows when the grip is dragged right', () => {
      setup();
      const before = parseInt(panel().style.width, 10);
      drag(60);
      expect(parseInt(panel().style.width, 10)).toBe(before - 60);
    });

    it('refuses to shrink below a usable minimum', () => {
      setup();
      drag(5000);
      expect(parseInt(panel().style.width, 10)).toBeGreaterThanOrEqual(240);
    });

    it('refuses to grow past a maximum', () => {
      setup();
      drag(-5000);
      expect(parseInt(panel().style.width, 10)).toBeLessThanOrEqual(900);
    });

    it('resets to its default width on double-click', () => {
      setup({ defaultWidth: 384 });
      drag(-150);
      expect(parseInt(panel().style.width, 10)).toBe(534);
      fireEvent.doubleClick(grip());
      expect(panel().style.width).toBe('384px');
    });
  });

  describe('persistence', () => {
    it('remembers its width across mounts', () => {
      const { unmount } = setup();
      drag(-100);
      const width = panel().style.width;
      unmount();

      setup();
      expect(panel().style.width).toBe(width);
    });

    // Two panels sharing one key would resize each other.
    it('keys storage per panel', () => {
      const { unmount } = setup({ storageKey: 'omnifex.test.a' });
      drag(-100);
      const a = panel().style.width;
      unmount();

      setup({ storageKey: 'omnifex.test.b' });
      expect(panel().style.width).not.toBe(a);
    });

    it('falls back to the default when storage holds nonsense', () => {
      localStorage.setItem('omnifex.test.panelWidth', '{{{');
      setup({ defaultWidth: 384 });
      expect(panel().style.width).toBe('384px');
    });

    it('clamps a stored width that is out of range', () => {
      localStorage.setItem('omnifex.test.panelWidth', '99999');
      setup();
      expect(parseInt(panel().style.width, 10)).toBeLessThanOrEqual(900);
    });
  });
});
