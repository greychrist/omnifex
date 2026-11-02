// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, cleanup, waitFor, act } from '@testing-library/react';

const dropPaths = vi.fn<() => Promise<string[]>>();
const saveDroppedFile = vi.fn<(name: string, data: string) => Promise<string>>();
vi.mock('@/lib/api', () => ({ api: { dropPaths: () => dropPaths(), saveDroppedFile: (n: string, d: string) => saveDroppedFile(n, d) } }));

import { useFileDropZone } from '../ImageAttachments';

function drop(files: File[]) {
  const e = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: { files, types: ['Files'] } });
  act(() => { document.dispatchEvent(e); });
  return e;
}

beforeEach(() => {
  dropPaths.mockReset().mockResolvedValue([]);
  saveDroppedFile.mockReset().mockImplementation(async (n) => `/copies/${n}`);
});
afterEach(() => { cleanup(); });

describe('useFileDropZone', () => {
  it('mentions a Finder file by its real path', async () => {
    dropPaths.mockResolvedValue(['/Users/g/report.pdf']);
    const onMention = vi.fn();
    renderHook(() => useFileDropZone({ enabled: true, onImage: vi.fn(), onMention }));
    drop([new File(['x'], 'report.pdf', { type: 'application/pdf' })]);
    await waitFor(() => expect(onMention).toHaveBeenCalledWith('/Users/g/report.pdf'));
    expect(saveDroppedFile).not.toHaveBeenCalled();
  });

  it('copies a file with no path and mentions the copy', async () => {
    const onMention = vi.fn();
    renderHook(() => useFileDropZone({ enabled: true, onImage: vi.fn(), onMention }));
    drop([new File(['hello'], 'notes.txt', { type: 'text/plain' })]);
    await waitFor(() => expect(onMention).toHaveBeenCalledWith('/copies/notes.txt'));
    expect(saveDroppedFile).toHaveBeenCalledWith('notes.txt', btoa('hello'));
  });

  it('inlines an image as a data URL', async () => {
    const onImage = vi.fn();
    renderHook(() => useFileDropZone({ enabled: true, onImage, onMention: vi.fn() }));
    drop([new File(['img'], 'a.png', { type: 'image/png' })]);
    await waitFor(() => expect(onImage).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/)));
  });

  it('ignores the drop in a tab that is not showing', async () => {
    const onMention = vi.fn();
    const onImage = vi.fn();
    renderHook(() => useFileDropZone({ enabled: false, onImage, onMention }));
    const e = drop([new File(['x'], 'a.txt', { type: 'text/plain' })]);
    await new Promise((r) => setTimeout(r, 20));
    expect(dropPaths).not.toHaveBeenCalled();
    expect(onMention).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});
