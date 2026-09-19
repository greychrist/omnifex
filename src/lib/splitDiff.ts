import type { DiffFile, DiffLine } from '@/lib/unifiedDiff';

/**
 * Fold a parsed unified diff into side-by-side rows.
 *
 * A unified diff is a single column: a removal is followed by its replacement.
 * A split view needs them on one row, which means pairing each run of `-`
 * lines with the run of `+` lines that follows it and padding the shorter side
 * with filler. That pairing is positional, not semantic — git does not tell us
 * which removal became which addition, and guessing (by similarity, say) would
 * produce a different alignment from `git diff --color-words` and from every
 * other viewer the reader has used.
 *
 * Pure and total: same file in, same rows out, no React and no I/O. The
 * rendering cost lives in the component; the alignment rules live here where
 * they can be tested without a DOM.
 */

export type SplitSideKind = 'ctx' | 'del' | 'add' | 'none';

export interface SplitCell {
  /** `none` is filler — the other side changed and this one has no counterpart. */
  kind: SplitSideKind;
  /** Line number on this side; always null for filler. */
  number: number | null;
  text: string;
}

export interface SplitPairRow {
  kind: 'pair';
  left: SplitCell;
  right: SplitCell;
}

export interface SplitGapRow {
  kind: 'gap';
  /** The `@@ … @@` line verbatim. */
  header: string;
  /** Unchanged lines skipped before this hunk, for the expand affordance. */
  hiddenBefore: number;
}

export type SplitRow = SplitPairRow | SplitGapRow;

const FILLER: SplitCell = { kind: 'none', number: null, text: '' };

function cell(kind: Exclude<SplitSideKind, 'none'>, line: DiffLine, side: 'old' | 'new'): SplitCell {
  return {
    kind,
    number: side === 'old' ? line.oldNumber : line.newNumber,
    text: line.text,
  };
}

/**
 * Pair a buffered run of removals with the run of additions that followed it.
 * Whichever run is longer dictates the row count; the other side gets filler.
 */
function flushRuns(dels: DiffLine[], adds: DiffLine[], out: SplitRow[]): void {
  const rows = Math.max(dels.length, adds.length);
  for (let i = 0; i < rows; i++) {
    const d = dels[i];
    const a = adds[i];
    out.push({
      kind: 'pair',
      left: d ? cell('del', d, 'old') : FILLER,
      right: a ? cell('add', a, 'new') : FILLER,
    });
  }
  dels.length = 0;
  adds.length = 0;
}

export function toSplitRows(file: DiffFile): SplitRow[] {
  const out: SplitRow[] = [];
  // Highest old-side line number emitted so far, so the next hunk can say how
  // many unchanged lines it skipped. Starts at 0 — before line 1.
  let lastOldLine = 0;

  for (const hunk of file.hunks) {
    const firstOld = hunk.lines.find((l) => l.oldNumber !== null)?.oldNumber ?? null;
    const hiddenBefore = firstOld === null ? 0 : Math.max(0, firstOld - lastOldLine - 1);
    out.push({ kind: 'gap', header: hunk.header, hiddenBefore });

    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];

    for (const line of hunk.lines) {
      if (line.kind === 'del') { dels.push(line); continue; }
      if (line.kind === 'add') { adds.push(line); continue; }
      // A context line ends any run in progress and sits on both sides.
      flushRuns(dels, adds, out);
      out.push({ kind: 'pair', left: cell('ctx', line, 'old'), right: cell('ctx', line, 'new') });
    }
    flushRuns(dels, adds, out);

    for (let i = hunk.lines.length - 1; i >= 0; i--) {
      const n = hunk.lines[i].oldNumber;
      if (n !== null) { lastOldLine = n; break; }
    }
  }

  return out;
}

/** Total rows a split render will mount, for sizing decisions. */
export function splitRowCount(file: DiffFile): number {
  return toSplitRows(file).length;
}
