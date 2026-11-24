import { qualifies } from './curate';
import { serializeNote } from './frontmatter';
import type { ParsedNote } from './types';

/** A ratio, not a tokenizer: the UI must label derived figures as estimates. */
export const BYTES_PER_TOKEN = 4;

const DATED_ENTRY = /^- \*\*\d{4}-\d{2}-\d{2}\*\*/;

export interface VaultStats {
  noteCount: number;
  totalBytes: number;
  byType: Record<string, number>;
  medianBytes: number;
  largestBytes: number;
  largestNote: string | null;
  estimatedTokens: { median: number; largest: number; vault: number };
  timelineBuckets: { label: string; count: number }[];
  spentUsd: number;
  qualifyingCount: number;
}

const BUCKET_ORDER = ['none', '1–3', '4–7', '8–15', '16+'];

function timelineLength(note: ParsedNote): number {
  let inTimeline = false;
  let count = 0;
  for (const line of note.body.split('\n')) {
    if (line.startsWith('## ')) {
      inTimeline = line.slice(3).trim() === 'Timeline';
      continue;
    }
    if (inTimeline && DATED_ENTRY.test(line)) count += 1;
  }
  return count;
}

function bucketOf(length: number): string {
  if (length === 0) return 'none';
  if (length <= 3) return '1–3';
  if (length <= 7) return '4–7';
  if (length <= 15) return '8–15';
  return '16+';
}

export function computeVaultStats(
  notes: { relPath: string; note: ParsedNote }[],
  today: string,
): VaultStats {
  const byType: Record<string, number> = {};
  const buckets = new Map<string, number>(BUCKET_ORDER.map((b) => [b, 0]));
  const sizes: number[] = [];

  let totalBytes = 0;
  let largestBytes = 0;
  let largestNote: string | null = null;
  let qualifyingCount = 0;

  for (const { relPath, note } of notes) {
    const bytes = Buffer.byteLength(serializeNote(note), 'utf8');
    sizes.push(bytes);
    totalBytes += bytes;
    if (bytes > largestBytes) {
      largestBytes = bytes;
      largestNote = relPath;
    }

    byType[note.frontmatter.type] = (byType[note.frontmatter.type] ?? 0) + 1;

    const bucket = bucketOf(timelineLength(note));
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);

    if (qualifies(note, today)) qualifyingCount += 1;
  }

  sizes.sort((a, b) => a - b);
  const medianBytes = sizes.length === 0 ? 0 : sizes[Math.floor((sizes.length - 1) / 2)];

  return {
    noteCount: notes.length,
    totalBytes,
    byType,
    medianBytes,
    largestBytes,
    largestNote,
    estimatedTokens: {
      median: Math.round(medianBytes / BYTES_PER_TOKEN),
      largest: Math.round(largestBytes / BYTES_PER_TOKEN),
      vault: Math.round(totalBytes / BYTES_PER_TOKEN),
    },
    timelineBuckets: BUCKET_ORDER.map((label) => ({ label, count: buckets.get(label) ?? 0 })),
    // Overwritten by the registry, which is the only layer that can read it.
    spentUsd: 0,
    qualifyingCount,
  };
}
