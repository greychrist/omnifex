// Cost Report — PDF export helpers, kept pure and out of both the view and
// the main process.
//
// The export renders the report a second time in a hidden window and prints
// that window to PDF. Three things have to cross a boundary for that to work,
// and all three are easy to get subtly wrong in a way that produces a
// plausible-looking but incorrect PDF, so they live here with tests:
//
//   • the filter state, carried into the print window through the URL hash
//   • the measured content size, converted from CSS pixels to the inches
//     `webContents.printToPDF` actually wants
//   • the default file name, which should name the range it covers
//
// Nothing here touches Electron, the DOM, or the clock.

// Relative, and from costFilterState rather than costReportFilters: this
// module is imported by the MAIN process, which resolves no `@/` alias and
// must not pull the renderer's API surface or localStorage into its bundle.
import {
  emptyFilterState,
  resolveRange,
  type CostFilterState,
  type CostScope,
  type RangeKey,
} from './costFilterState';

/** Marks a renderer boot as "render the print view, not the app shell". */
export const PRINT_HASH_KEY = 'print';
export const PRINT_HASH_VALUE = 'cost-report';

/** CSS reference pixels per inch. Fixed by the CSS spec, not by the display. */
const CSS_PX_PER_INCH = 96;

/**
 * Largest page a PDF can express, in inches, per the format's 14400-point
 * limit on either dimension. A report taller than this is scaled to fit
 * rather than cut off — see `pdfPageSize`.
 */
export const MAX_PDF_INCHES = 200;

// ── Filter state ⇄ URL hash ────────────────────────────────────────────────

const ARRAY_KEYS = ['accounts', 'models', 'projects'] as const;
const SCOPES: readonly CostScope[] = ['all', 'main', 'subagent'];
const RANGE_KEYS: readonly RangeKey[] = ['month', 'last-month', 'all'];
const GROUP_BYS = ['day', 'week', 'month'] as const;

/**
 * Encode filter state as a URL hash for the print window.
 *
 * `URLSearchParams` does the escaping, which is the whole point: a project
 * path is arbitrary text, and one containing `&` or `=` would otherwise split
 * into extra filter entries and silently change what the PDF reports on.
 * Arrays are repeated keys rather than a joined string for the same reason —
 * no separator to collide with a path.
 */
export function buildPrintHash(state: CostFilterState): string {
  const p = new URLSearchParams();
  p.set(PRINT_HASH_KEY, PRINT_HASH_VALUE);
  p.set('rangeKey', state.rangeKey);
  p.set('customStart', state.customStart);
  p.set('customEnd', state.customEnd);
  p.set('scope', state.scope);
  p.set('groupBy', state.groupBy);
  for (const key of ARRAY_KEYS) {
    for (const v of state[key]) p.append(key, v);
  }
  return `#${p.toString()}`;
}

/**
 * Decode a print-window hash, or null when this boot is a normal app window.
 *
 * Unrecognised enum values fall back to their defaults rather than throwing: a
 * truncated or hand-edited hash should render a visibly-wrong report, not an
 * exception in a window the user cannot see.
 */
export function parsePrintHash(hash: string): CostFilterState | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;

  let p: URLSearchParams;
  try {
    p = new URLSearchParams(raw);
  } catch {
    return null;
  }
  if (p.get(PRINT_HASH_KEY) !== PRINT_HASH_VALUE) return null;

  const state = emptyFilterState();
  const rangeKey = p.get('rangeKey');
  if (rangeKey && (RANGE_KEYS as readonly string[]).includes(rangeKey)) {
    state.rangeKey = rangeKey as RangeKey;
  }
  const scope = p.get('scope');
  if (scope && (SCOPES as readonly string[]).includes(scope)) {
    state.scope = scope as CostScope;
  }
  const groupBy = p.get('groupBy');
  if (groupBy && (GROUP_BYS as readonly string[]).includes(groupBy)) {
    state.groupBy = groupBy as CostFilterState['groupBy'];
  }
  state.customStart = p.get('customStart') ?? '';
  state.customEnd = p.get('customEnd') ?? '';
  for (const key of ARRAY_KEYS) state[key] = p.getAll(key);

  return state;
}

// ── Measured pixels → printToPDF options ───────────────────────────────────

export interface PdfPageSize {
  /** Inches — what `PrintToPDFOptions.pageSize` expects in Electron 41. */
  pageSize: { width: number; height: number };
  /** Passed straight to `PrintToPDFOptions.scale`. */
  scale: number;
}

/**
 * Turn the print window's measured content box into a single-page PDF size.
 *
 * The chosen export is "screenshot-faithful, one tall page", so the page is
 * exactly as tall as the report rather than paginated. Past the PDF format's
 * 200in ceiling that stops being possible, and the choice is between cutting
 * the report off and shrinking it. It shrinks: a truncated cost report is
 * missing panels, which is the failure this feature exists to prevent.
 *
 * Defensive against a garbage measurement (a hidden window that never laid
 * out can report 0) because the alternative is `printToPDF` rejecting, or
 * worse, emitting a zero-size page.
 */
export function pdfPageSize(content: { widthPx: number; heightPx: number }): PdfPageSize {
  const widthPx = usablePx(content.widthPx, 1152);
  const heightPx = usablePx(content.heightPx, 1152);

  const maxPx = MAX_PDF_INCHES * CSS_PX_PER_INCH;
  const scale = Math.min(1, maxPx / heightPx);

  return {
    scale,
    pageSize: {
      width: (widthPx * scale) / CSS_PX_PER_INCH,
      height: (heightPx * scale) / CSS_PX_PER_INCH,
    },
  };
}

function usablePx(v: number, fallback: number): number {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// ── Default file name ──────────────────────────────────────────────────────

/**
 * Default name offered in the save dialog, naming the range the PDF covers.
 *
 * Resolved the same way the queries resolve it — explicit dates beat the
 * preset — so the file name cannot disagree with the numbers inside it.
 */
export function pdfFileName(state: CostFilterState, today: string): string {
  const preset = resolveRange(state.rangeKey, today);
  const start = state.customStart || preset.startDate;
  const end = state.customEnd || preset.endDate || today;
  if (!start) return 'cost-report-all-time.pdf';
  return `cost-report-${start}-to-${end}.pdf`;
}
