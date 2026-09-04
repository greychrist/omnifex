import { describe, it, expect } from 'vitest';
import { emptyFilterState, type CostFilterState } from '@/lib/costReportFilters';
import {
  MAX_PDF_INCHES,
  buildPrintHash,
  parsePrintHash,
  pdfFileName,
  pdfPageSize,
} from '@/lib/costReportPrint';

function filters(over: Partial<CostFilterState> = {}): CostFilterState {
  return { ...emptyFilterState(), ...over };
}

describe('print hash round-trip', () => {
  // The print window is a second renderer loading the same index.html. The
  // hash is the only channel that carries "which report" into it, so a lossy
  // round-trip means the PDF silently shows a different range than the page
  // the user pressed the button on.

  it('round-trips a default filter state', () => {
    const f = filters();
    expect(parsePrintHash(buildPrintHash(f))).toEqual(f);
  });

  it('round-trips every field, including multi-value arrays', () => {
    const f = filters({
      rangeKey: 'last-month',
      customStart: '2026-08-01',
      customEnd: '2026-08-31',
      accounts: ['acct-1', 'acct-2'],
      models: ['claude-opus-5', 'claude-fable-5-1'],
      projects: ['/Users/alice/proj', '/Users/alice/other proj'],
      scope: 'subagent',
      groupBy: 'week',
    });
    expect(parsePrintHash(buildPrintHash(f))).toEqual(f);
  });

  it('round-trips values containing the separators it encodes with', () => {
    // A project path is arbitrary text. Commas and ampersands in one would
    // otherwise split into extra filter entries.
    const f = filters({ projects: ['/Users/alice/a,b&c=d', '/Users/alice/#x'] });
    expect(parsePrintHash(buildPrintHash(f))).toEqual(f);
  });

  it('tolerates a leading # on the hash, as location.hash supplies it', () => {
    const f = filters({ scope: 'main' });
    expect(parsePrintHash(buildPrintHash(f))).toEqual(f);
    expect(parsePrintHash(`#${buildPrintHash(f).replace(/^#/, '')}`)).toEqual(f);
  });

  it('returns null for a hash that is not a cost-report print request', () => {
    expect(parsePrintHash('')).toBeNull();
    expect(parsePrintHash('#')).toBeNull();
    expect(parsePrintHash('#/settings')).toBeNull();
    expect(parsePrintHash('#print=something-else')).toBeNull();
  });

  it('falls back to defaults for a malformed value rather than throwing', () => {
    // A hand-edited or truncated hash must not crash the print window; it
    // renders the default report instead, which is visibly wrong rather than
    // invisibly blank.
    const parsed = parsePrintHash('#print=cost-report&scope=nonsense&groupBy=nonsense');
    expect(parsed).not.toBeNull();
    expect(parsed?.scope).toBe('all');
    expect(parsed?.groupBy).toBe('day');
  });
});

describe('pdfPageSize', () => {
  // printToPDF takes pageSize in INCHES (Electron 41 typings) while the
  // renderer measures CSS pixels, at 96 per inch. Getting that conversion
  // wrong yields a PDF that is comically the wrong size, so it is pinned.

  it('converts CSS pixels to inches at 96 per inch', () => {
    const { pageSize, scale } = pdfPageSize({ widthPx: 1152, heightPx: 4800 });
    expect(pageSize.width).toBeCloseTo(12, 6);
    expect(pageSize.height).toBeCloseTo(50, 6);
    expect(scale).toBe(1);
  });

  it('leaves scale at 1 for a report within the PDF page limit', () => {
    const { scale } = pdfPageSize({ widthPx: 1152, heightPx: MAX_PDF_INCHES * 96 });
    expect(scale).toBe(1);
  });

  it('scales an over-long report down instead of truncating it', () => {
    // "One tall page" plus a hard 200in PDF page limit means a very long
    // report has to shrink to fit. Cutting it off would drop panels, which
    // is the one thing this feature exists to avoid.
    const heightPx = MAX_PDF_INCHES * 96 * 2;
    const { pageSize, scale } = pdfPageSize({ widthPx: 1152, heightPx });
    expect(scale).toBeCloseTo(0.5, 6);
    expect(pageSize.height).toBeLessThanOrEqual(MAX_PDF_INCHES);
    expect(pageSize.height).toBeCloseTo(MAX_PDF_INCHES, 6);
    // Width shrinks with it, so the aspect ratio — and the layout — is intact.
    expect(pageSize.width).toBeCloseTo(6, 6);
  });

  it('never returns a zero or negative page, whatever it is handed', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { pageSize, scale } = pdfPageSize({ widthPx: bad, heightPx: bad });
      expect(pageSize.width).toBeGreaterThan(0);
      expect(pageSize.height).toBeGreaterThan(0);
      expect(scale).toBeGreaterThan(0);
      expect(Number.isFinite(pageSize.width)).toBe(true);
      expect(Number.isFinite(pageSize.height)).toBe(true);
    }
  });
});

describe('pdfFileName', () => {
  it('names the file after the resolved range', () => {
    expect(pdfFileName(filters({ rangeKey: 'month' }), '2026-09-04')).toBe(
      'cost-report-2026-09-01-to-2026-09-04.pdf',
    );
  });

  it('uses explicit dates when they are set', () => {
    expect(
      pdfFileName(filters({ customStart: '2026-08-01', customEnd: '2026-08-31' }), '2026-09-04'),
    ).toBe('cost-report-2026-08-01-to-2026-08-31.pdf');
  });

  it('says all-time when the range is unbounded', () => {
    expect(pdfFileName(filters({ rangeKey: 'all' }), '2026-09-04')).toBe(
      'cost-report-all-time.pdf',
    );
  });
});
