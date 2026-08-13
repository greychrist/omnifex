// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { SelectComponent } from '@/components/ui/select';

/**
 * Radix Select needs three DOM APIs jsdom does not implement. Without them the
 * trigger throws on open and every assertion below is unreachable.
 */
beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

/**
 * Split so Tailwind's scanner does not see a complete class name here.
 *
 * Tailwind v4 scans raw source text — test files and COMMENTS included — and
 * generates a rule for anything that looks like a utility. Spelling it out
 * whole anywhere in this repo emits the height rule into the bundle forever:
 * dead CSS no element uses, and a false positive for anyone grepping the built
 * output to check whether this bug is back. (Measured: it took three rebuilds
 * to notice the comments were doing it.)
 */
const VIEWPORT_HEIGHT_CLASS = 'h-[var(--radix-select-trigger' + '-height)]';

const OPTIONS = [
  { value: '1', label: 'personal' },
  { value: '2', label: 'work' },
  { value: '3', label: 'local' },
];

function openSelect(triggerClass?: string) {
  render(
    <SelectComponent
      value="1"
      onValueChange={() => {}}
      options={OPTIONS}
      className={triggerClass}
    />,
  );
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
}

describe('SelectComponent dropdown sizing', () => {
  /**
   * The regression this pins:
   *
   * The Viewport is the SCROLL CONTAINER holding the options. Binding its
   * height to the trigger-height custom property makes it exactly as tall as
   * the trigger — 28px for the Brain tab's `h-7` switcher — so a three-account
   * list becomes a one-line scrolling window with scroll buttons and hover
   * auto-scroll. It reads as a laggy, sticky dropdown.
   *
   * Radix's documented way to bound a popper Select is
   * `max-height: var(--radix-select-content-available-height)` on the CONTENT,
   * never a fixed height on the viewport.
   *
   * This asserts on a class name, which is a proxy: jsdom computes no layout,
   * so it cannot see the visual result. It catches the exact reintroduction,
   * not the general class of bug.
   */
  it('does not pin the options viewport to the trigger height', () => {
    openSelect('h-7 w-56 text-xs');

    const viewport = document.querySelector('[data-radix-select-viewport]');
    expect(viewport).not.toBeNull();
    expect(viewport?.className ?? '').not.toContain(VIEWPORT_HEIGHT_CLASS);
  });

  it('still renders every option', () => {
    openSelect('h-7 w-56 text-xs');
    for (const o of OPTIONS) {
      expect(screen.getByRole('option', { name: o.label })).toBeTruthy();
    }
  });
});
