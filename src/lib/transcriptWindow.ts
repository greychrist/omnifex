/** `pinned` is an absolute row index: while scrolled back the window's top stays put so nothing being read unmounts. `null` follows the tail. */
export const TRANSCRIPT_WINDOW_ROWS = 150;

export function windowStart(total: number, pinned: number | null): number {
  const tail = Math.max(0, total - TRANSCRIPT_WINDOW_ROWS);
  return pinned === null ? tail : Math.max(0, Math.min(pinned, tail));
}

export function earlierStart(start: number): number {
  return Math.max(0, start - TRANSCRIPT_WINDOW_ROWS);
}
