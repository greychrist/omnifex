// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';

// See RawJsonPopover.test.tsx: the component cache is load-bearing. A Proxy
// that builds a fresh component per property access remounts the subtree on
// every render and silently wipes the popover's own state.
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

import { CardActionBar } from '@/components/CardActionBar';

// `message` is read two different ways: `extractCopyText` walks its
// top-level `content`, while the viewer shows `raw` — the full wire record.
const raw = { type: 'assistant', message: { content: [{ type: 'text', text: 'hello there' }] } };
const message = {
  content: [{ type: 'text', text: 'hello there' }],
  raw,
};

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('CardActionBar', () => {
  it('puts the payload viewer next to the copy button', () => {
    render(<CardActionBar message={message} />);
    const bar = screen.getByRole('toolbar');
    const labels = [...bar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Copy content', 'View raw JSON']);
  });

  it('shows the raw wire payload when the viewer is opened', () => {
    render(<CardActionBar message={message} />);
    fireEvent.click(screen.getByRole('button', { name: 'View raw JSON' }));
    expect(screen.getByTestId('raw-json-body').textContent)
      .toBe(JSON.stringify(raw, null, 2));
  });

  it('copies the message body from the bar and the raw payload from the panel', async () => {
    render(<CardActionBar message={message} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy content' }));
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith('hello there'); });

    fireEvent.click(screen.getByRole('button', { name: 'View raw JSON' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenLastCalledWith(JSON.stringify(raw, null, 2));
    });
  });

  it('offers no viewer when there is no payload to show', () => {
    render(<CardActionBar text="just text" />);
    expect(screen.queryByRole('button', { name: 'View raw JSON' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy content' })).toBeTruthy();
  });

  // The regression this replaced: serializing the payload in the render body
  // cost ~5ms and 2.7MB per transcript re-render, on every card, whether or
  // not anyone ever looked at it.
  it('does not serialize the payload until the viewer is opened', () => {
    const serialize = vi.fn(() => '{"serialized":true}');
    render(<CardActionBar text="x" rawPayload={serialize} />);
    expect(serialize).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'View raw JSON' }));
    expect(serialize).toHaveBeenCalled();
    expect(screen.getByTestId('raw-json-body').textContent).toBe('{"serialized":true}');
  });
});
