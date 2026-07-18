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

/**
 * Once the auto-start effect has decided to `rebind-or-resume`, this picks
 * between reattaching to the live main-process session and resuming the
 * selected one.
 *
 * `sessionRebind` / `sessionGetHealth` are keyed by **tabId**, not session id.
 * A reused tab (navigate back to Projects, then open a *different* session
 * into the same tab) can still hold a live handle for the previous session.
 * Blindly rebinding reattaches the tab — its stream, context usage, and
 * `claudeSessionId` (and therefore the cost pill) — to the wrong session.
 *
 * So only `rebind` when the live session IS the one the user opened (the
 * genuine renderer-reload / same-session case). Otherwise `resume` the
 * selected session; the caller tears down any stale handle first.
 */
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
