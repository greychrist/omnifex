import { useEffect, useState } from 'react';
import type { BrainRunPhase } from '@/lib/api';

// One wording for the titlebar pill and the Brain tab banner: describing a run in two places made them disagree on screen.

export const PHASE_LABEL: Record<BrainRunPhase, string> = {
  preparing: 'preparing',
  distilling: 'reading',
  extracting: 'extracting',
  writing: 'writing notes',
  curating: 'curating',
};

// Clamped at zero: `startedAt` is the daemon's clock, read against the renderer's.
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

// Ticks while active: run frames arrive only per phase change, so a frame-driven timer would freeze.
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
