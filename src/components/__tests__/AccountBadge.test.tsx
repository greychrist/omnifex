// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { AccountBadge } from '../AccountBadge';

// AccountBadge resolves color/icon/type via useAccounts() when the props
// aren't supplied. We stub the hook so the component renders without
// needing a real provider.
vi.mock('@/contexts/AccountsContext', () => ({
  useAccounts: () => ({
    accounts: [],
    refresh: async () => {},
    getColor: () => null,
    getIcon: () => null,
    getAccountType: () => null,
  }),
}));

// AccountBadge also reads the active theme so it can darken text +
// soften background mix in light mode. Default the mock to "gray" (the
// dark theme) so existing tests keep their original expectations;
// light-mode tests below override per-test.
const themeRef: { current: 'gray' | 'light' } = { current: 'gray' };
vi.mock('@/hooks', () => ({
  useTheme: () => ({
    theme: themeRef.current,
    setTheme: async () => {},
  }),
}));

beforeEach(() => {
  themeRef.current = 'gray';
});

afterEach(() => { cleanup(); });

describe('AccountBadge — size variants', () => {
  it('defaults to text-[11px] and a 14px icon (size unspecified)', () => {
    const { container } = render(<AccountBadge name="alpha" color="#abcdef" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(/text-\[11px\]/);
    const svg = root.querySelector('svg');
    expect(svg?.getAttribute('class')).toMatch(/h-\[14px\]/);
    expect(svg?.getAttribute('class')).toMatch(/w-\[14px\]/);
  });

  it('size="sm" emits text-xs and a 15px icon to match a text-xs container (e.g. a select dropdown)', () => {
    const { container } = render(
      <AccountBadge name="alpha" color="#abcdef" size="sm" />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(/text-xs/);
    expect(root.className).not.toMatch(/text-\[11px\]/);
    const svg = root.querySelector('svg');
    expect(svg?.getAttribute('class')).toMatch(/h-\[15px\]/);
    expect(svg?.getAttribute('class')).toMatch(/w-\[15px\]/);
  });

  it('size="sm" still works when no color is supplied — fallback color path', () => {
    const { container } = render(
      <AccountBadge name="alpha" size="sm" />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(/text-xs/);
    // The fallback (no-color) icon is intentionally one notch smaller
    // than the colored variant — better visual balance against the
    // muted preset color stack.
    const svg = root.querySelector('svg');
    expect(svg?.getAttribute('class')).toMatch(/h-\[12px\]/);
  });
});

describe('AccountBadge — theme-aware colored variants', () => {
  // jsdom normalizes hex colors in inline styles to `rgb(...)`. The
  // production browser keeps the original hex, but for assertion the
  // canonical rgb form of `#abcdef` (171,205,239) is what surfaces.
  const RGB_ABCDEF = /rgb\(\s*171,?\s*205,?\s*239\s*\)/;

  it('gray theme: text uses the raw account color, bg/border mix toward transparent', () => {
    themeRef.current = 'gray';
    const { container } = render(<AccountBadge name="alpha" color="#abcdef" />);
    const root = container.firstElementChild as HTMLElement;
    const styleAttr = root.getAttribute('style') ?? '';
    expect(RGB_ABCDEF.test(styleAttr)).toBe(true);
    expect(styleAttr).toContain('transparent');
    expect(styleAttr).not.toContain('white');
    expect(styleAttr).not.toContain('black');
  });

  it('light theme: text mixes toward black, bg toward white, border toward white — readable on a light surface', () => {
    themeRef.current = 'light';
    const { container } = render(<AccountBadge name="alpha" color="#abcdef" />);
    const root = container.firstElementChild as HTMLElement;
    const styleAttr = root.getAttribute('style') ?? '';
    // Three color-mix expressions on the same element: bg toward
    // white, fg toward black, border toward white. The rgb form of
    // the account color appears in each mix.
    expect(styleAttr.match(/rgb\(\s*171,?\s*205,?\s*239\s*\)/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(3);
    expect(styleAttr).toContain('white');
    expect(styleAttr).toContain('black');
    // No `transparent` mix in the light path — that's the source of
    // the original "yellow on white" invisibility bug.
    expect(styleAttr).not.toContain('transparent');
  });

  it('compact variant also responds to theme — light mode mixes toward white', () => {
    themeRef.current = 'light';
    const { container } = render(
      <AccountBadge name="alpha" color="#abcdef" variant="compact" />,
    );
    const root = container.firstElementChild as HTMLElement;
    const styleAttr = root.getAttribute('style') ?? '';
    expect(styleAttr).toContain('white');
    expect(styleAttr).toContain('black');
  });
});
