// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

import { POPOVER_SECTION, popoverOption } from '@/components/ui/popover-list';
import { EffortPickerDropdown, PermissionPickerDropdown } from '@/components/ControlBar';
import { ModelPickerDropdown } from '@/components/ModelPicker';
import { FALLBACK_MODELS } from '@/lib/modelCatalog';

afterEach(() => { cleanup(); });

/**
 * The status-bar popovers are one family, laid out in the account popover's
 * grammar (`AccountDetails`): small-caps section label, xs rows. The pickers
 * used to bring their own frame — a bordered heading strip, p-3 text-sm rows,
 * and a p-1 box inside the popover's own p-4 — and read as a different app.
 */
describe('picker dropdowns wear the status-bar popover grammar', () => {
  const classesOf = (el: Element) => el.className.split(/\s+/);

  it('permissions: section label and option rows', () => {
    render(<PermissionPickerDropdown normalizedMode="default" onOpenChange={() => {}} />);
    expect(classesOf(screen.getByText('Permissions'))).toEqual(expect.arrayContaining(POPOVER_SECTION.split(' ')));
    const active = screen.getByText('Default').closest('button')!;
    expect(classesOf(active)).toEqual(expect.arrayContaining(popoverOption(true).split(' ')));
    expect(active.className).not.toMatch(/\btext-sm\b|\bp-3\b/);
  });

  it('effort: section label and option rows', () => {
    render(<EffortPickerDropdown effort="high" onSelect={() => {}} />);
    expect(classesOf(screen.getByText('Effort'))).toEqual(expect.arrayContaining(POPOVER_SECTION.split(' ')));
    const row = screen.getByText('High').closest('button')!;
    expect(classesOf(row)).toEqual(expect.arrayContaining(popoverOption(true).split(' ')));
  });

  it('model: section label and option rows', () => {
    render(<ModelPickerDropdown models={FALLBACK_MODELS} selectedModel="sonnet" onSelect={() => {}} />);
    expect(classesOf(screen.getByText('Model').parentElement!)).toEqual(expect.arrayContaining(POPOVER_SECTION.split(' ')));
    const row = screen.getByText('Sonnet').closest('button')!;
    expect(classesOf(row)).toEqual(expect.arrayContaining(popoverOption(true).split(' ')));
    expect(row.className).not.toMatch(/\btext-sm\b|\bp-3\b/);
  });
});
