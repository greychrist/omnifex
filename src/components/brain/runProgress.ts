import { useEffect, useState } from 'react';
import type { BrainRunPhase } from '@/lib/api';

/**
 * How a run in flight is described, shared by the two places that draw one.
 *
 * The titlebar pill and the Brain tab's banner report the same `BrainRun`, and
 * every time they have described it differently the two have disagreed on
 * screen — one reading "0 of 2" while the other read "1 of 2", one dropping the
 * counter that the other kept. The wording lives here so that cannot recur.
 */

/**
 * What each stage is called on screen.
 *
 * Present-participle throughout, so it reads as a continuation of the verb
 * already in the line: "Indexing Personal vault · 1 of 1 · extracting".
 */
export const PHASE_LABEL: Record<BrainRunPhase, string> = {
  preparing: 'preparing',
  distilling: 'reading',
  extracting: 'extracting',
  writing: 'writing notes',
  curating: 'curating',
};

/**
 * Elapsed as `m:ss`, growing to `h:mm:ss` only once it has to.
 *
 * Clamped at zero: `startedAt` is stamped by the main process and read against
 * the renderer's clock, so a frame that arrives a few ms "early" must not
 * render a negative timer.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0
    ? `${String(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${String(minutes)}:${pad(seconds)}`;
}

/**
 * A once-a-second `Date.now()`, but only while something is running.
 *
 * Run frames arrive per phase change, and the extraction phase alone can last
 * minutes. A timer redrawn only on a frame would sit frozen at the one number
 * it exists to keep moving — telling a slow item from a wedged one. Gated on
 * `active` so an idle app schedules nothing.
 */
export function useRunClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(timer); };
  }, [active]);
  return now;
}
