// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { POPOVER_SECTION, popoverOption } from '@/components/ui/popover-list';
import { EffortPickerDropdown, PermissionPickerDropdown } from '@/components/ControlBar';
import { ModelPickerDropdown } from '@/components/ModelPicker';
import { FALLBACK_MODELS } from '@/lib/modelCatalog';

afterEach(() => { cleanup(); });

describe('picker dropdowns wear the status-bar popover grammar', () => {
  const classesOf = (el: Element) => el.className.split(/\s+/);

  it('permissions: section label and option rows', () => {
    render(<PermissionPickerDropdown normalizedMode="default" onOpenChange={() => {}} />);
    expect(classesOf(screen.getByText('Permissions').parentElement!)).toEqual(expect.arrayContaining(POPOVER_SECTION.split(' ')));
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

  it('effort: every short-name badge sits in a column wide enough for "Auto"', () => {
    render(<EffortPickerDropdown effort="high" onSelect={() => {}} />);
    for (const short of ['Auto', 'Lo', 'Med', 'Hi', 'Xhi', 'Max']) {
      const badge = screen.getByText(short, { selector: 'span' });
      expect(classesOf(badge)).toEqual(expect.arrayContaining(['w-9', 'shrink-0']));
    }
  });

  it('model: section label and option rows', () => {
    render(<ModelPickerDropdown models={FALLBACK_MODELS} selectedModel="sonnet" onSelect={() => {}} />);
    expect(classesOf(screen.getByText('Model').parentElement!)).toEqual(expect.arrayContaining(POPOVER_SECTION.split(' ')));
    const row = screen.getByText('Sonnet').closest('button')!;
    expect(classesOf(row)).toEqual(expect.arrayContaining(popoverOption(true).split(' ')));
    expect(row.className).not.toMatch(/\btext-sm\b|\bp-3\b/);
  });

  it('permissions: marks the account default mode, with the key in the heading', () => {
    render(<PermissionPickerDropdown normalizedMode="plan" defaultMode="acceptEdits" onOpenChange={() => {}} />);
    expect(screen.getByText('Accept Edits *')).toBeInTheDocument();
    expect(screen.getByText('* account default')).toBeInTheDocument();
    expect(screen.queryByText('Plan *')).toBeNull();
    const highlighted = (text: string) => classesOf(screen.getByText(text).closest('button')!).includes('bg-accent');
    expect(highlighted('Plan')).toBe(true);
    expect(highlighted('Accept Edits *')).toBe(false);
  });

  it('permissions: no mark and no key without an account default', () => {
    render(<PermissionPickerDropdown normalizedMode="plan" onOpenChange={() => {}} />);
    expect(screen.queryByText(/\*/)).toBeNull();
  });
});
