/**
 * The transcript's tail window: which rows are mounted.
 *
 * Every open tab stays mounted, and the transcript used to render every row it
 * had. A 10k-record session (1,568 rows, 45k DOM nodes) cost WebKit ~600 MB for
 * that tab alone, and the live heap that made slowed every GC and every streamed
 * record — the typing lag traced 2026-11-17. So only the newest rows mount;
 * older ones come in a window at a time when the reader scrolls up to them.
 *
 * `pinned` is an absolute row index: while the reader is scrolled back, the
 * window's top stays put as records stream in, so nothing they are reading
 * unmounts. `null` means following the tail.
 */
export const TRANSCRIPT_WINDOW_ROWS = 150;

/** First mounted row. */
export function windowStart(total: number, pinned: number | null): number {
  const tail = Math.max(0, total - TRANSCRIPT_WINDOW_ROWS);
  return pinned === null ? tail : Math.max(0, Math.min(pinned, tail));
}

/** The start one window earlier than `start`. */
export function earlierStart(start: number): number {
  return Math.max(0, start - TRANSCRIPT_WINDOW_ROWS);
}
