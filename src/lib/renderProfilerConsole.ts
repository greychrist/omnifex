import type { ProfileReport, RenderProfiler } from '@/lib/renderProfiler';
import { renderProfiler } from '@/lib/renderProfiler';

export interface ProfilerConsoleHandle {
  on: () => void;
  off: () => void;
  status: () => { enabled: boolean; last: ProfileReport | null };
}

const GLOBAL_KEY = '__omnifexProfile';

export interface ConsoleDeps {
  log?: (report: ProfileReport) => void;
}

function defaultLog(report: ProfileReport): void {
  const { interaction, durationMs, totalRenders, renders } = report;
   
  console.log(
    `[profile] ${interaction}: ${totalRenders} renders in ${durationMs.toFixed(1)}ms`,
    renders,
  );
}

/** Idempotent, so a hot reload cannot stack duplicate subscribers. */
export function installRenderProfilerConsole(
  target: Record<string, unknown>,
  profiler: RenderProfiler = renderProfiler,
  deps: ConsoleDeps = {},
): void {
  if (target[GLOBAL_KEY]) return;

  const log = deps.log ?? defaultLog;
  let last: ProfileReport | null = null;

  profiler.onReport((report) => {
    last = report;
    log(report);
  });

  const handle: ProfilerConsoleHandle = {
    on() {
      profiler.setEnabled(true);
       
      console.log('[profile] on — reload once so every component re-registers.');
    },
    off() {
      profiler.setEnabled(false);
       
      console.log('[profile] off');
    },
    status: () => ({ enabled: profiler.isEnabled(), last }),
  };

  target[GLOBAL_KEY] = handle;
}
