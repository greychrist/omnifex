// Only the active tab auto-starts: every restored chat tab is mounted, so N tabs would spawn N CLIs at launch.
export type AutoStartAction = 'rebind-or-resume' | 'fresh-start' | 'skip';

export interface AutoStartArgs {
  isActive: boolean;
  alreadyStarted: boolean;
  hasSession: boolean;
  hasInitialSessionConfig: boolean;
}

export function decideAutoStart(args: AutoStartArgs): AutoStartAction {
  if (!args.isActive || args.alreadyStarted) return 'skip';
  if (args.hasSession) return 'rebind-or-resume';
  if (args.hasInitialSessionConfig) return 'fresh-start';
  return 'skip';
}

/** Rebind only when the live session IS the selected one: rebind/health are keyed by tabId, and a reused tab may hold another session. */
export type RebindTarget = 'rebind' | 'resume';

export interface RebindTargetArgs {
  healthAlive: boolean;
  healthSessionId: string | null;
  selectedSessionId: string;
}

export function decideRebindTarget(args: RebindTargetArgs): RebindTarget {
  if (args.healthAlive && args.healthSessionId === args.selectedSessionId) {
    return 'rebind';
  }
  return 'resume';
}

/** A tab with a transcript is never new: sessionStarted goes false on any mid-life stop (CLI crash, daemon restart). */
export interface NewSessionPanelArgs {
  sessionStarted: boolean;
  hasTranscript: boolean;
}

export function shouldShowNewSessionPanel(args: NewSessionPanelArgs): boolean {
  return !args.sessionStarted && !args.hasTranscript;
}
