import type { DiffFile, DiffLine } from '@/lib/unifiedDiff';

// Pairing of -/+ runs is positional, not semantic, to match git and every other viewer.

export type SplitSideKind = 'ctx' | 'del' | 'add' | 'none';

export interface SplitCell {
  /** `none` is filler — the other side changed and this one has no counterpart. */
  kind: SplitSideKind;
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
  header: string;
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

export function splitRowCount(file: DiffFile): number {
  return toSplitRows(file).length;
}
