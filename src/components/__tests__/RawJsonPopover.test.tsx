// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';

// Animation wrappers render as plain DOM so assertions are synchronous.
// The component cache is load-bearing: a Proxy that builds a fresh component
// on every property access remounts the whole subtree on every render, which
// silently wipes the popover's `copied` state and makes the copy-feedback
// assertion fail for a reason that has nothing to do with the component.
vi.mock('framer-motion', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock factory hoisted before module imports settle.
  const React = require('react');
  const cache = new Map<string, unknown>();
  return {
    motion: new Proxy({}, {
      get: (_, key) => {
        const Tag = key as string;
        if (!cache.has(Tag)) {
          cache.set(Tag, React.forwardRef(({ children, ...rest }: any, ref: unknown) => {
            const { initial, animate, exit, transition, layout, whileTap, ...domProps } = rest;
            void initial; void animate; void exit; void transition; void layout; void whileTap;
            return React.createElement(Tag, { ...domProps, ref }, children);
          }));
        }
        return cache.get(Tag);
      },
    }),
    AnimatePresence: ({ children }: any) => children,
  };
});

import { RawJsonPopover } from '@/components/StreamMessage/RawJsonPopover';

const SAMPLE = JSON.stringify({ type: 'user', origin: { kind: 'task-notification' } }, null, 2);

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('RawJsonPopover', () => {
  it('offers a view affordance, not a copy one, as its trigger', () => {
    render(<RawJsonPopover text={SAMPLE} />);
    expect(screen.getByRole('button', { name: /view raw json/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^copy$/i })).toBeNull();
  });

  // The whole point of the change: the old footer button copied on click,
  // giving no way to just look at the payload.
  it('does not copy when the trigger is clicked', () => {
    render(<RawJsonPopover text={SAMPLE} />);
    fireEvent.click(screen.getByRole('button', { name: /view raw json/i }));
    expect(writeText).not.toHaveBeenCalled();
  });

  it('shows the payload when opened', () => {
    render(<RawJsonPopover text={SAMPLE} />);
    fireEvent.click(screen.getByRole('button', { name: /view raw json/i }));
    expect(screen.getByTestId('raw-json-body').textContent).toBe(SAMPLE);
  });

  it('scrolls the body rather than growing the popover unboundedly', () => {
    render(<RawJsonPopover text={SAMPLE} />);
    fireEvent.click(screen.getByRole('button', { name: /view raw json/i }));
    const body = screen.getByTestId('raw-json-body');
    const cls = (body.parentElement as HTMLElement).className;
    expect(cls).toMatch(/overflow-(auto|y-auto)/);
    expect(cls).toMatch(/max-h-/);
  });

  it('copies the exact payload from the button inside the popover', async () => {
    render(<RawJsonPopover text={SAMPLE} />);
    fireEvent.click(screen.getByRole('button', { name: /view raw json/i }));
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(SAMPLE);
    });
  });

  it('confirms the copy in place so the popover can stay open', async () => {
    render(<RawJsonPopover text={SAMPLE} />);
    fireEvent.click(screen.getByRole('button', { name: /view raw json/i }));
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    await waitFor(() => {
      expect(screen.getByText(/copied/i)).toBeTruthy();
    });
    // Still open — looking at the payload is the primary use.
    expect(screen.getByTestId('raw-json-body')).toBeTruthy();
  });

  it('renders nothing when there is no payload to show', () => {
    const { container } = render(<RawJsonPopover text="" />);
    expect(container.textContent).toBe('');
  });
});
