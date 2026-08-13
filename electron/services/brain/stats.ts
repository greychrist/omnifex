import { qualifies } from './curate';
import { serializeNote } from './frontmatter';
import type { ParsedNote } from './types';

/**
 * What the Brain costs, and whether curation is firing at the right time
 * (spec §5).
 *
 * Pure: the registry does the reading, this does the arithmetic. The threshold
 * in `curate.ts` was inherited from Rowboat and never measured against a real
 * vault; `qualifyingCount` and `timelineBuckets` are what replace that
 * inheritance with an observation.
 */

/**
 * Rough characters per token. This is a RATIO, not a tokenizer — the UI must
 * label every figure derived from it as an estimate, because presenting it as
 * exact would be a claim the number cannot support.
 */
export const BYTES_PER_TOKEN = 4;

const DATED_ENTRY = /^- \*\*\d{4}-\d{2}-\d{2}\*\*/;

export interface VaultStats {
  noteCount: number;
  totalBytes: number;
  /** Note type → count. Keys are `NoteType` values. */
  byType: Record<string, number>;
  medianBytes: number;
  largestBytes: number;
  largestNote: string | null;
  /** Every figure here is derived from BYTES_PER_TOKEN. Label as estimated. */
  estimatedTokens: { median: number; largest: number; vault: number };
  timelineBuckets: { label: string; count: number }[];
  /**
   * What indexing this vault has cost so far, in USD.
   *
   * Not derivable from the notes — it lives in `brain_sources`, which the
   * registry sums and layers on. `computeVaultStats` therefore reports 0 and
   * the registry overwrites it; the alternative was passing a DB handle into a
   * pure fold over Markdown.
   */
  spentUsd: number;
  qualifyingCount: number;
  recentlyCurated: { relPath: string; curatedAt: string }[];
}

/** How many curated notes to name. Enough to spot a bad run, not a log. */
const RECENT_LIMIT = 10;

const BUCKET_ORDER = ['none', '1–3', '4–7', '8–15', '16+'];

/**
 * Dated Timeline bullets in a note.
 *
 * Scans the body directly rather than going through `parseSections`: this runs
 * over every note in the vault on each reading, and the section map allocates
 * per note for two numbers this only needs one of.
 */
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
  const curated: { relPath: string; curatedAt: string }[] = [];

  let totalBytes = 0;
  let largestBytes = 0;
  let largestNote: string | null = null;
  let qualifyingCount = 0;

  for (const { relPath, note } of notes) {
    // The canonical serialization, which is byte-for-byte what is on disk for
    // every machine-written note — and what a retrieval actually pays for.
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
    if (note.frontmatter.curated_at !== undefined) {
      curated.push({ relPath, curatedAt: note.frontmatter.curated_at });
    }
  }

  sizes.sort((a, b) => a - b);
  const medianBytes = sizes.length === 0 ? 0 : sizes[Math.floor((sizes.length - 1) / 2)];

  curated.sort(
    (a, b) => b.curatedAt.localeCompare(a.curatedAt) || a.relPath.localeCompare(b.relPath),
  );

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
    recentlyCurated: curated.slice(0, RECENT_LIMIT),
  };
}
