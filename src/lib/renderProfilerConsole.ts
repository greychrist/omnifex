// Devtools entry point for the render profiler.
//
// The lag this measures was reported in a PACKAGED build, where there is no
// dev overlay and no StrictMode — but the app menu still carries
// `role: 'toggleDevTools'`, so a console handle is the whole UI we need:
//
//   __omnifexProfile.on()      // then reload once
//   ...click a tab, drag a tab...
//   __omnifexProfile.status()  // last report
//   __omnifexProfile.off()
//
// Reports also print as they land, so the numbers show up next to the
// interaction that produced them rather than having to be asked for.

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
  // eslint-disable-next-line no-console
  console.log(
    `[profile] ${interaction}: ${totalRenders} renders in ${durationMs.toFixed(1)}ms`,
    renders,
  );
}

/**
 * Attach the handle to `target` (the window, in the app) and subscribe the
 * printer. Idempotent: a second call on the same target is a no-op, so a
 * hot-reload can't stack duplicate subscribers and double-print every report.
 */
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
      // eslint-disable-next-line no-console
      console.log('[profile] on — reload once so every component re-registers.');
    },
    off() {
      profiler.setEnabled(false);
      // eslint-disable-next-line no-console
      console.log('[profile] off');
    },
    status: () => ({ enabled: profiler.isEnabled(), last }),
  };

  target[GLOBAL_KEY] = handle;
}
