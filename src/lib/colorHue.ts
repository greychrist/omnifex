/**
 * OKLCH hue and chroma of a hex colour — what Modern's prompt bubble and
 * answer card take from Settings › Chats › Modern. Each card keeps its own
 * lightness (styles.css), so only the hue is read, plus the chroma to tell
 * whether there is a hue at all: white, greys and black have none, and the
 * angle of their near-zero a/b is noise (white reads as ~90°, a yellow).
 *
 * sRGB → linear → OKLab (Björn Ottosson's matrices) → atan2(b, a), hypot(a, b).
 */
function oklab(hex: string): { a: number; b: number } | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex);
  if (!m) return null;
  const digits = m[1].length === 3 ? m[1].replace(/./g, (d) => d + d) : m[1].slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(digits.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    a: 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s,
  };
}

/** Hue in degrees, [0, 360). Meaningless when `hexChroma` is about zero. */
export function hexHue(hex: string): number | null {
  const lab = oklab(hex);
  if (!lab) return null;
  const deg = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

export function hexChroma(hex: string): number | null {
  const lab = oklab(hex);
  return lab ? Math.hypot(lab.a, lab.b) : null;
}

/** Below this a colour reads as white, grey or black — no hue to take. */
export const NEUTRAL_CHROMA = 0.015;
