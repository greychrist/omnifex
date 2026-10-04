// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  diagramFileName,
  svgForExport,
  svgToPng,
  canCopyImage,
  downloadBlob,
} from '@/lib/diagramExport';

const MERMAID_SVG =
  '<svg id="m1" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 897.09375px;" viewBox="4 4 897.09375 234"><g/></svg>';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('diagramFileName', () => {
  it('stamps the local date and time', () => {
    expect(diagramFileName('svg', new Date(2026, 9, 4, 6, 7))).toBe('diagram-2026-10-04-0607.svg');
  });
});

describe('svgForExport', () => {
  it('gives the svg a fixed size from its viewBox and an XML header', () => {
    const out = svgForExport(MERMAID_SVG);
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    const svg = new DOMParser().parseFromString(out, 'image/svg+xml').documentElement;
    expect(svg.getAttribute('width')).toBe('898');
    expect(svg.getAttribute('height')).toBe('234');
    expect(svg.getAttribute('style') ?? '').not.toContain('max-width');
    expect(svg.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg');
  });
});

describe('svgToPng', () => {
  it('draws at the requested scale over a white background', async () => {
    const fillRect = vi.fn();
    const drawImage = vi.fn();
    const ctx = { fillRect, drawImage, fillStyle: '' };
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => {
      cb(new Blob(['png'], { type: 'image/png' }));
    });
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) { queueMicrotask(() => this.onload?.()); }
    });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();

    const blob = await svgToPng(MERMAID_SVG, 2);

    expect(blob.type).toBe('image/png');
    const drawn = getContext.mock.contexts[0] as HTMLCanvasElement;
    expect(drawn.width).toBe(1796);
    expect(drawn.height).toBe(468);
    expect(ctx.fillStyle).toBe('#ffffff');
    expect(fillRect).toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x');
  });
});

describe('canCopyImage', () => {
  it('needs ClipboardItem, a secure context and clipboard.write', () => {
    vi.stubGlobal('ClipboardItem', function ClipboardItem() { /* presence is all that is checked */ });
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { write: vi.fn() } });
    expect(canCopyImage()).toBe(true);

    vi.stubGlobal('isSecureContext', false);
    expect(canCopyImage()).toBe(false);

    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('ClipboardItem', undefined);
    expect(canCopyImage()).toBe(false);
  });
});

describe('downloadBlob', () => {
  it('clicks a temporary link to the blob and releases it', () => {
    URL.createObjectURL = vi.fn(() => 'blob:y');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    downloadBlob(new Blob(['x']), 'diagram.svg');
    expect(click).toHaveBeenCalledTimes(1);
    const a = click.mock.contexts[0] as HTMLAnchorElement;
    expect(a.download).toBe('diagram.svg');
    expect(a.href).toBe('blob:y');
    expect(document.body.contains(a)).toBe(false);
  });
});
