/**
 * Decides what ClaudeCodeSession's auto-start effect should do on mount /
 * when isActive flips. Pulled out as a pure function so the gate logic is
 * testable in isolation — the effect itself just dispatches on the result.
 *
 * Why the isActive gate exists: TabContent renders every restored chat tab
 * (CSS-hidden when not active). Without this gate, opening the app with N
 * saved chat tabs would fire N rebind/resume attempts at launch — burning
 * quota and spawning N Claude subprocesses for tabs the user hasn't even
 * looked at yet.
 */
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
