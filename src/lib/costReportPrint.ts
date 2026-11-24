import {
  emptyFilterState,
  resolveRange,
  type CostFilterState,
  type CostScope,
  type RangeKey,
} from './costFilterState';

export const PRINT_HASH_KEY = 'print';
export const PRINT_HASH_VALUE = 'cost-report';

const CSS_PX_PER_INCH = 96;

/** The PDF format's 14400-point limit; a taller report is scaled to fit, never cut off. */
export const MAX_PDF_INCHES = 200;

const ARRAY_KEYS = ['accounts', 'models', 'projects'] as const;
const SCOPES: readonly CostScope[] = ['all', 'main', 'subagent'];
const RANGE_KEYS: readonly RangeKey[] = ['month', 'last-month', 'all'];
const GROUP_BYS = ['day', 'week', 'month'] as const;

/** URLSearchParams escaping and repeated keys: a path containing `&` or `=` must not split into extra filters. */
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

export interface PdfPageSize {
  /** Inches. */
  pageSize: { width: number; height: number };
  scale: number;
}

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

export function pdfFileName(state: CostFilterState, today: string): string {
  const preset = resolveRange(state.rangeKey, today);
  const start = state.customStart || preset.startDate;
  const end = state.customEnd || preset.endDate || today;
  if (!start) return 'cost-report-all-time.pdf';
  return `cost-report-${start}-to-${end}.pdf`;
}
