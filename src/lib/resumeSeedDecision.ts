/**
 * Follow a changed prop id even when a live id is set: open paths reassign `sessionData` without resetting the slice.
 * Never stomp a stream-forked `claudeSessionId` back to the prop id. First sight seeds only when nothing is live.
 */
export interface ResumeSeedInput {
  sessionId: string | null;
  claudeSessionId: string | null;
  /** `undefined` = first run. */
  prevSessionId: string | null | undefined;
}

export function decideResumeSeed(input: ResumeSeedInput): 'reseed' | 'skip' {
  const { sessionId, claudeSessionId, prevSessionId } = input;
  if (sessionId == null) return 'skip';

  const firstSight = prevSessionId === undefined;
  const propChanged = !firstSight && prevSessionId !== sessionId;

  if (propChanged) return 'reseed';

  if (firstSight && claudeSessionId == null) return 'reseed';

  return 'skip';
}
