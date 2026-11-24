import type { ThemeMode } from '@/contexts/ThemeContext';
import { THEME_SURFACES } from './mermaidTheme';

/** Only the drawing sees this rewrite; the Source view and copies keep the original. Labels are SVG text, so HTML tags would print literally. */

type Rgb = [number, number, number];

const FORMAT_TAG = /<\/?(?:b|strong|i|em|u)\s*>/gi;

function isFlowchart(source: string): boolean {
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('%%') || line === '---') continue;
    return /^(flowchart|graph)\b/.test(line);
  }
  return false;
}

function toMarkdownLabel(inner: string): string {
  const md = inner
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(b|strong)\s*>\s*([\s\S]*?)\s*<\/\1\s*>/gi, '**$2**')
    .replace(/<(i|em)\s*>\s*([\s\S]*?)\s*<\/\1\s*>/gi, '*$2*')
    .replace(FORMAT_TAG, '')
    .split('\n')
    .map((l) => l.trim())
    .join('\n');
  return `"\`${md}\`"`;
}

function rewriteLabels(source: string): string {
  if (!isFlowchart(source)) return source.replace(FORMAT_TAG, '');
  return source.replace(/"([^"\n]*)"/g, (whole, inner: string) => {
    if (inner.startsWith('`')) return whole;
    FORMAT_TAG.lastIndex = 0;
    return FORMAT_TAG.test(inner) ? toMarkdownLabel(inner) : whole;
  });
}

const NAMED: Record<string, string> = {
  red: '#ff0000', orange: '#ffa500', yellow: '#ffff00', gold: '#ffd700', green: '#008000',
  lime: '#00ff00', teal: '#008080', cyan: '#00ffff', blue: '#0000ff', navy: '#000080',
  purple: '#800080', violet: '#ee82ee', magenta: '#ff00ff', pink: '#ffc0cb',
  lightblue: '#add8e6', lightgreen: '#90ee90', lightyellow: '#ffffe0', lavender: '#e6e6fa',
};

function parseColor(value: string): Rgb | null {
  const v = value.trim().toLowerCase();
  const hex = NAMED[v] ?? v;
  let m = /^#([0-9a-f]{3,4})$/.exec(hex);
  if (m) {
    const h = m[1];
    return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16)) as Rgb;
  }
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(hex);
  if (m) {
    const h = m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

function constColor(value: string): Rgb {
  const c = parseColor(value);
  if (!c) throw new Error(`unparseable built-in color: ${value}`);
  return c;
}

/** HSL hue in degrees, saturation and lightness in 0..1. */
function hsl([r, g, b]: Rgb): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

const toHex = (c: Rgb) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => a[i] * t + b[i] * (1 - t)) as Rgb;

const ACCENT_500: Record<string, string> = {
  red: '#fb2c36', orange: '#ff6900', amber: '#fe9a00', emerald: '#00bc7d', teal: '#00bba7',
  sky: '#00a6f4', blue: '#2b7fff', indigo: '#615fff', violet: '#8e51ff', pink: '#f6339a',
};

type PerTheme = Record<ThemeMode, string>;
export interface Accent { name: string; fill: PerTheme; stroke: PerTheme; text: PerTheme }

const ACCENTS: (Accent & { hue: number })[] = Object.entries(ACCENT_500).map(([name, hex]) => {
  const c = constColor(hex);
  const surface = (t: ThemeMode) => constColor(THEME_SURFACES[t].node);
  const text = (t: ThemeMode) => constColor(THEME_SURFACES[t].text);
  return {
    name,
    hue: hsl(c)[0],
    fill: { gray: toHex(mix(c, surface('gray'), 0.16)), light: toHex(mix(c, surface('light'), 0.1)) },
    stroke: { gray: toHex(mix(c, surface('gray'), 0.6)), light: toHex(mix(c, surface('light'), 0.5)) },
    text: { gray: toHex(mix(c, text('gray'), 0.12)), light: toHex(mix(c, text('light'), 0.15)) },
  };
});

export function accentFor(color: string): Accent | null {
  const rgb = parseColor(color);
  if (!rgb) return null;
  const [h, s, l] = hsl(rgb);
  if (s < 0.15 || l < 0.04 || l > 0.985) return null;
  let best = ACCENTS[0];
  let bestDist = Infinity;
  for (const a of ACCENTS) {
    const d = Math.min(Math.abs(a.hue - h), 360 - Math.abs(a.hue - h));
    if (d < bestDist) { best = a; bestDist = d; }
  }
  return best;
}

const COLOR_KEYS = new Set(['fill', 'stroke', 'color', 'stroke-width']);

function rewriteStyleLine(line: string, theme: ThemeMode): string {
  const m = /^(\s*(?:classDef|style)\s+\S+\s+)(.+?);?\s*$/.exec(line);
  if (!m) return line;
  const segments = m[2].split(',').map((raw) => {
    const i = raw.indexOf(':');
    return i === -1 ? null : { key: raw.slice(0, i).trim().toLowerCase(), value: raw.slice(i + 1).trim(), raw: raw.trim() };
  });
  if (segments.some((s) => s === null)) return line;
  const props = segments as { key: string; value: string; raw: string }[];
  const get = (k: string) => props.find((p) => p.key === k)?.value ?? '';
  const accent = accentFor(get('fill')) ?? accentFor(get('stroke'));
  const kept = props.filter((p) => !COLOR_KEYS.has(p.key)).map((p) => p.raw);
  const colors = accent
    ? [`fill:${accent.fill[theme]}`, `stroke:${accent.stroke[theme]}`, 'stroke-width:1px', `color:${accent.text[theme]}`]
    : [];
  // An empty classDef is a parse error, and dropping it would orphan its `class` statements.
  const all = [...colors, ...kept];
  return `${m[1]}${all.length ? all.join(',') : 'stroke-width:1px'}`;
}

function rewriteColors(source: string, theme: ThemeMode): string {
  return source
    .split('\n')
    .map((line) => rewriteStyleLine(line, theme))
    .join('\n');
}

export function prepareSource(source: string, theme: ThemeMode): string {
  return rewriteColors(rewriteLabels(source), theme);
}
