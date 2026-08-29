import { describe, it, expect, vi } from 'vitest';
import {
  buildContextMenuTemplate,
  lookUpLabel,
  type ContextMenuActions,
} from '../context-menu-template';

function actions(): ContextMenuActions {
  return {
    openLink: vi.fn(),
    copyLink: vi.fn(),
    lookUpSelection: vi.fn(),
  };
}

const labels = (t: ReturnType<typeof buildContextMenuTemplate>) =>
  t.map((i) => i.label ?? i.role ?? i.type);

describe('lookUpLabel', () => {
  it('quotes the selection the way macOS does', () => {
    expect(lookUpLabel('invitation')).toBe('Look Up “invitation”');
  });

  it('collapses internal whitespace and newlines', () => {
    expect(lookUpLabel('multi\n  word   phrase')).toBe('Look Up “multi word phrase”');
  });

  it('trims surrounding whitespace', () => {
    expect(lookUpLabel('  Agents \n')).toBe('Look Up “Agents”');
  });

  it('truncates long selections with an ellipsis', () => {
    const label = lookUpLabel('a'.repeat(80));
    expect(label).toBe(`Look Up “${'a'.repeat(24)}…”`);
  });
});

describe('buildContextMenuTemplate — Look Up', () => {
  it('puts Look Up above Copy when text is selected on macOS', () => {
    const t = buildContextMenuTemplate(
      { selectionText: 'Agents', editFlags: {} },
      actions(),
      { platform: 'darwin' }
    );
    expect(labels(t)).toEqual(['Look Up “Agents”', 'separator', 'copy', 'separator', 'selectAll']);
  });

  it('invokes the lookUpSelection action when clicked', () => {
    const a = actions();
    const t = buildContextMenuTemplate(
      { selectionText: 'Agents', editFlags: {} },
      a,
      { platform: 'darwin' }
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t[0].click as any)();
    expect(a.lookUpSelection).toHaveBeenCalledOnce();
  });

  it('offers Look Up inside editable fields with a selection', () => {
    const t = buildContextMenuTemplate(
      { selectionText: 'invitation', isEditable: true, editFlags: { canCopy: true, canCut: true } },
      actions(),
      { platform: 'darwin' }
    );
    expect(labels(t)[0]).toBe('Look Up “invitation”');
    expect(labels(t)).toContain('paste');
  });

  it('omits Look Up when nothing is selected', () => {
    const t = buildContextMenuTemplate({ selectionText: '   ', editFlags: {} }, actions(), {
      platform: 'darwin',
    });
    expect(labels(t).some((l) => String(l).startsWith('Look Up'))).toBe(false);
  });

  it('omits Look Up off macOS — showDefinitionForSelection is macOS-only', () => {
    const t = buildContextMenuTemplate({ selectionText: 'Agents', editFlags: {} }, actions(), {
      platform: 'win32',
    });
    expect(labels(t)).toEqual(['copy', 'separator', 'selectAll']);
  });

  it('keeps link items above Look Up', () => {
    const t = buildContextMenuTemplate(
      { selectionText: 'Agents', linkURL: 'https://example.com', editFlags: {} },
      actions(),
      { platform: 'darwin' }
    );
    expect(labels(t).slice(0, 4)).toEqual([
      'Open Link',
      'Copy Link',
      'separator',
      'Look Up “Agents”',
    ]);
  });
});

describe('buildContextMenuTemplate — existing behaviour', () => {
  it('offers the full edit set in editable fields, gated by editFlags', () => {
    const t = buildContextMenuTemplate(
      { isEditable: true, editFlags: { canCopy: false, canPaste: true, canSelectAll: true } },
      actions(),
      { platform: 'darwin' }
    );
    expect(labels(t)).toEqual(['cut', 'copy', 'paste', 'separator', 'selectAll']);
    expect(t.find((i) => i.role === 'copy')?.enabled).toBe(false);
    expect(t.find((i) => i.role === 'paste')?.enabled).toBe(true);
  });

  it('falls back to Select All on empty background clicks', () => {
    const t = buildContextMenuTemplate({ editFlags: {} }, actions(), { platform: 'darwin' });
    expect(labels(t)).toEqual(['selectAll']);
  });

  it('wires the link actions to the clicked URL', () => {
    const a = actions();
    const t = buildContextMenuTemplate(
      { linkURL: 'https://example.com', editFlags: {} },
      a,
      { platform: 'darwin' }
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t[0].click as any)();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t[1].click as any)();
    expect(a.openLink).toHaveBeenCalledWith('https://example.com');
    expect(a.copyLink).toHaveBeenCalledWith('https://example.com');
  });
});
