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

// Split: Tailwind v4 scans source text, comments included, and would emit the
// rule for a whole class name.
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
  // Binding the Viewport (the scroll container) to the trigger-height variable
  // makes it exactly as tall as the trigger.
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
