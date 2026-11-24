// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { AccountBadge } from '../AccountBadge';

vi.mock('@/contexts/AccountsContext', () => ({
  useAccounts: () => ({
    accounts: [],
    refresh: async () => {},
    getColor: () => null,
    getIcon: () => null,
    getAccountType: () => null,
  }),
}));

// Default to "gray" (the dark theme); light-mode tests override per test.
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
    const svg = root.querySelector('svg');
    expect(svg?.getAttribute('class')).toMatch(/h-\[12px\]/);
  });
});

describe('AccountBadge — theme-aware colored variants', () => {
  // jsdom normalizes inline hex colors to rgb(...): #abcdef is (171,205,239).
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
    expect(styleAttr.match(/rgb\(\s*171,?\s*205,?\s*239\s*\)/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(3);
    expect(styleAttr).toContain('white');
    expect(styleAttr).toContain('black');
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

describe('AccountBadge — hideName', () => {
  it('shows the name by default and hides it on request, keeping the icon', () => {
    const { container, unmount } = render(<AccountBadge name="Personal" />);
    expect(screen.getByText(/Personal/)).toBeTruthy();
    expect(container.querySelector('svg')).not.toBeNull();
    unmount();

    render(<AccountBadge name="Personal" hideName />);
    expect(screen.queryByText(/Personal/)).toBeNull();
    expect(document.querySelector('svg')).not.toBeNull();
  });

  it('names the account in a tooltip once the label is gone', () => {
    const { container } = render(<AccountBadge name="Personal" hideName />);
    expect(container.firstElementChild?.getAttribute('title')).toBe('Personal');
  });

  it('keeps the identity shield when the name is hidden', () => {
    render(<AccountBadge name="Personal" hideName verification="mismatch" />);
    expect(screen.getByLabelText(/DIFFERENT account/)).toBeTruthy();
  });
});
