import { useEffect, useState } from 'react';

/**
 * One shared one-second clock for every subscriber.
 *
 * The tab strip needs a ticking `now` to render prompt-cache countdown state,
 * but giving each tab its own interval would mean N timers for one clock. A
 * module-level interval with a subscriber set means exactly one timer no matter
 * how many tabs are open — and no timer at all when nothing is counting.
 */
let interval: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  if (interval === null) {
    interval = setInterval(() => {
      for (const sub of subscribers) sub();
    }, 1000);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  };
}

/**
 * Current wall clock in ms, refreshed every second while `active`.
 *
 * When `active` goes false the subscription drops (so an expired countdown
 * stops costing renders) and the last value is retained. Flipping back to true
 * re-syncs immediately rather than waiting out a tick.
 */
export function useSecondTick(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    return subscribe(() => { setNowMs(Date.now()); });
  }, [active]);

  return nowMs;
}
