// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { IconPicker, AVAILABLE_ICONS, ICON_MAP } from '../IconPicker';

// framer-motion + Radix Dialog both rely on layout effects + portals that
// don't compose cleanly with jsdom. Mock motion.* as plain DOM and let
// Radix Dialog mount inline via its `forceMount` fallback behavior — the
// Dialog itself doesn't gate rendering on `open={true}` for our assertions
// because we always render with isOpen=true.
vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: (_, key) => {
        const Tag = key as string;
        return ({ children, ...rest }: any) => {
          const { initial, animate, exit, transition, whileHover, whileTap, ...domProps } = rest;
          void initial; void animate; void exit; void transition; void whileHover; void whileTap;
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock factory hoisted before module imports settle.
          return require('react').createElement(Tag, domProps, children);
        };
      },
    },
  ),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(() => { cleanup(); });

describe('IconPicker — exports', () => {
  it('AVAILABLE_ICONS contains all category icons by name', () => {
    expect(AVAILABLE_ICONS).toContain('home');
    expect(AVAILABLE_ICONS).toContain('settings');
    expect(AVAILABLE_ICONS).toContain('star');
    expect(AVAILABLE_ICONS.length).toBeGreaterThan(50);
  });

  it('ICON_MAP exposes each icon component keyed by name', () => {
    expect(typeof ICON_MAP.home).toBe('object'); // React.forwardRef component
    expect(ICON_MAP.settings).toBeDefined();
    // Every AVAILABLE_ICONS entry should have a matching ICON_MAP entry.
    for (const name of AVAILABLE_ICONS) {
      expect(ICON_MAP[name]).toBeDefined();
    }
  });
});

describe('IconPicker — search', () => {
  it('renders category headers when no query is entered', () => {
    render(
      <IconPicker value="" onSelect={() => {}} isOpen onClose={() => {}} />,
    );
    // "Interface & Navigation" is one of the categories defined in the source.
    expect(screen.getByText(/Interface & Navigation/i)).toBeDefined();
  });

  it('filters to matching icons and hides empty categories on type', () => {
    render(
      <IconPicker value="" onSelect={() => {}} isOpen onClose={() => {}} />,
    );
    const input = screen.getByPlaceholderText(/Search icons/i);
    fireEvent.change(input, { target: { value: 'home' } });
    // "home" matches at least one icon button (the home icon).
    const buttons = document.querySelectorAll('button');
    // Confirm we narrowed the result set significantly (full grid > 50 buttons).
    expect(buttons.length).toBeLessThan(40);
  });

  it('shows a no-results message when nothing matches', () => {
    render(
      <IconPicker value="" onSelect={() => {}} isOpen onClose={() => {}} />,
    );
    fireEvent.change(screen.getByPlaceholderText(/Search icons/i), {
      target: { value: 'zzzzzz-definitely-not-an-icon' },
    });
    expect(screen.getByText(/No icons found for/i)).toBeDefined();
  });
});

describe('IconPicker — selection', () => {
  it('clicking an icon calls onSelect then onClose', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <IconPicker value="" onSelect={onSelect} isOpen onClose={onClose} />,
    );
    // Narrow to a single icon via search so we can pick it deterministically.
    fireEvent.change(screen.getByPlaceholderText(/Search icons/i), {
      target: { value: 'home' },
    });
    const buttons = document.querySelectorAll('button');
    // Find the icon-grid button (skip the Dialog's built-in close X button).
    const iconButton = Array.from(buttons).find(
      (btn) => btn.className.includes('p-2.5'),
    );
    expect(iconButton).toBeDefined();
    fireEvent.click(iconButton!);
    expect(onSelect).toHaveBeenCalledWith('home');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('IconPicker — footer', () => {
  it('reports the total number of available icons', () => {
    render(
      <IconPicker value="" onSelect={() => {}} isOpen onClose={() => {}} />,
    );
    expect(
      screen.getByText(new RegExp(`${AVAILABLE_ICONS.length} icons available`)),
    ).toBeDefined();
  });
});
