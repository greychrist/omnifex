/**
 * Getting a drawn diagram out of the app: SVG and PNG files, and a PNG on the
 * clipboard where the platform allows it.
 *
 * Callers pass a light-theme render (see MermaidBlock): exports are meant for
 * other people's documents, which are overwhelmingly white, so a dark-mode
 * diagram is never what should land there.
 */

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `diagram-YYYY-MM-DD-HHMM.<ext>`, in local time. */
export function diagramFileName(ext: string, now: Date = new Date()): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `diagram-${date}-${pad(now.getHours())}${pad(now.getMinutes())}.${ext}`;
}

function parse(svgMarkup: string): SVGSVGElement {
  return new DOMParser().parseFromString(svgMarkup, 'image/svg+xml').documentElement as unknown as SVGSVGElement;
}

/** Size of the drawing from its viewBox, rounded up to whole pixels. */
export function viewBoxSize(svg: SVGSVGElement): { width: number; height: number } {
  const parts = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const [, , w = 0, h = 0] = parts;
  return { width: Math.ceil(w), height: Math.ceil(h) };
}

/**
 * A standalone SVG file. Mermaid emits `width="100%"` plus a `max-width`
 * style so it fits its container; a file opened on its own needs a real size.
 */
export function svgForExport(svgMarkup: string): string {
  const svg = parse(svgMarkup);
  const { width, height } = viewBoxSize(svg);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.style.removeProperty('max-width');
  if (!svg.getAttribute('style')) svg.removeAttribute('style');
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return XML_HEADER + new XMLSerializer().serializeToString(svg);
}

/** Rasterises the SVG at `scale`× over white. */
export async function svgToPng(svgMarkup: string, scale = 2): Promise<Blob> {
  const file = svgForExport(svgMarkup);
  const { width, height } = viewBoxSize(parse(svgMarkup));
  const url = URL.createObjectURL(new Blob([file], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => { resolve(); };
      img.onerror = () => { reject(new Error('Could not load the diagram as an image')); };
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Could not encode the PNG'));
      }, 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Image copy needs the async clipboard and a secure context. The iPad client
 * served over plain http has neither, so the option is hidden there.
 */
export function canCopyImage(): boolean {
  return (
    typeof ClipboardItem !== 'undefined' &&
    globalThis.isSecureContext &&
    typeof navigator.clipboard?.write === 'function'
  );
}

export async function copyPng(png: Blob): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    // Deferred: revoking in the same tick can cancel the download in Safari.
    setTimeout(() => { URL.revokeObjectURL(url); }, 0);
  }
}
