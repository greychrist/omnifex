/**
 * Decide whether the AgentSession "resume" effect should (re)seed
 * `claudeSessionId` from the `session` prop and reload that session's history.
 *
 * Two forces move a tab's session id, and they must not fight:
 *
 *  - The **session prop** (`tab.sessionData`) changes when the user selects a
 *    different session to view. When that happens we MUST follow it, even if a
 *    live id is already set — otherwise the tab stays pinned to whatever
 *    session first seeded it (the header cost pill, driven by
 *    `useSessionCost`'s `session-cost:<id>` channel, then shows the wrong
 *    session's total forever). Several open paths reassign `sessionData`
 *    without resetting the per-tab store slice, so we cannot rely on
 *    `claudeSessionId` having been nulled first.
 *
 *  - The **live stream** advances `claudeSessionId` to the CLI's actual (often
 *    forked-on-resume) id via `onSessionInit` / the reducer's
 *    `sessionIdUpdate`. That divergence leaves the prop id stable while
 *    `claudeSessionId` moves on. We must NOT stomp it back to the pre-fork
 *    prop id — the regression commit 3c60728 fixed.
 *
 * The distinguishing signal is which value changed: if the **prop** id changed
 * the user switched (reseed); if only `claudeSessionId` changed the stream
 * forked (skip).
 *
 * `prevSessionId === undefined` marks the effect's first run for this mounted
 * component (no prior prop observed). On a remount over an already-live tab
 * (store slice persists, e.g. tab switched away and back) that first run must
 * NOT stomp the live id, so first-sight only seeds when nothing live exists.
 */
export interface ResumeSeedInput {
  /** The `session` prop's id (`tab.sessionData?.id`), or null when no session. */
  sessionId: string | null;
  /** The current live id in the per-tab store slice. */
  claudeSessionId: string | null;
  /** Prop id seen on the previous effect run; `undefined` = first run. */
  prevSessionId: string | null | undefined;
}

export function decideResumeSeed(input: ResumeSeedInput): 'reseed' | 'skip' {
  const { sessionId, claudeSessionId, prevSessionId } = input;
  if (sessionId == null) return 'skip';

  const firstSight = prevSessionId === undefined;
  const propChanged = !firstSight && prevSessionId !== sessionId;

  // User selected a different session — follow it regardless of any live id.
  if (propChanged) return 'reseed';

  // Initial mount of a session that has no live id yet — seed + load. A remount
  // over an already-live tab (claudeSessionId set) falls through to skip so the
  // stream-advanced id survives.
  if (firstSight && claudeSessionId == null) return 'reseed';

  return 'skip';
}
