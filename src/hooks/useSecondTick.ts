import { useEffect, useState } from 'react';

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

export function useSecondTick(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    return subscribe(() => { setNowMs(Date.now()); });
  }, [active]);

  return nowMs;
}
