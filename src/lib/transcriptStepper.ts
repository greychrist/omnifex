import { forwardedParentToolUseId } from '@/lib/subagentDispatch';
import type { JsonlNode } from '@/types/jsonl';

/**
 * Row-by-row navigation for the transcript: the scroll math behind the
 * prev / next / last-prompt buttons in `ClaudeTranscript`.
 *
 * Kept out of the component and free of DOM types so the stepping rules are
 * testable without rendering. The component's only job is to measure row tops
 * and hand them here — it queries `[data-transcript-step]` /
 * `[data-transcript-prompt]` rather than indexing an array, because hard
 * filters and compact-mode grouping both change which nodes become rows.
 *
 * Both button pairs run the same `stepTarget`; prompt navigation differs only
 * in which selector supplies the offsets.
 */

/**
 * Breathing room left above the row we land on. Without it the row sits flush
 * against the top edge of the scroll container and reads as clipped.
 */
export const STEP_MARGIN_PX = 12;

/**
 * How far past a row's top still counts as "parked on this row".
 *
 * Must exceed `STEP_MARGIN_PX`: landing puts the viewport that margin *above*
 * the row's top, so with less slack the row just arrived at is still strictly
 * below the scroll position and every press re-selects it.
 */
const PARKED_EPSILON_PX = STEP_MARGIN_PX + 4;

export type StepDirection = 'prev' | 'next';

const scrollPositionFor = (offset: number) => Math.max(0, offset - STEP_MARGIN_PX);

/**
 * The scroll position that puts the adjacent row at the top of the viewport,
 * or null when there is no row that way.
 *
 * `offsets` are row tops relative to the scroll container's content, in
 * document order.
 */
export function stepTarget(opts: {
  offsets: number[];
  scrollTop: number;
  direction: StepDirection;
  epsilon?: number;
}): number | null {
  const { offsets, scrollTop, direction, epsilon = PARKED_EPSILON_PX } = opts;

  if (direction === 'next') {
    const next = offsets.find((o) => o > scrollTop + epsilon);
    return next === undefined ? null : scrollPositionFor(next);
  }

  const ceiling = scrollTop - epsilon;
  for (let i = offsets.length - 1; i >= 0; i -= 1) {
    if (offsets[i] < ceiling) return scrollPositionFor(offsets[i]);
  }
  return null;
}

/**
 * Whether a row is somewhere the prev/next buttons can land.
 *
 * Everything is a stop except the /compact summary: it is session machinery
 * rather than conversation, and it is long, so stepping through a compacted
 * session should pass over it rather than park on it.
 */
export function isStepStop(node: JsonlNode): boolean {
  return !(node.kind === 'user' && node.userKind === 'compact-summary');
}

/**
 * Whether a row is one of the user's own prompts — the anchor for
 * "jump to my last prompt".
 *
 * Narrower than `isStepStop`: meta rows (skill bodies, image markers) and
 * compact summaries are `user` records but not things the user typed, and a
 * subagent's prompt belongs to the subagent. Same main-thread exclusions the
 * turn-anchor derivations in `sessionDerivedState` already make.
 */
export function isMainPrompt(node: JsonlNode): boolean {
  if (node.kind !== 'user' || node.userKind !== 'prompt') return false;
  if ((node.raw as { isSidechain?: boolean }).isSidechain === true) return false;
  return forwardedParentToolUseId(node.raw) === null;
}
