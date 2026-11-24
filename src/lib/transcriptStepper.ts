import { forwardedParentToolUseId } from '@/lib/subagentDispatch';
import type { JsonlNode } from '@/types/jsonl';

export const STEP_MARGIN_PX = 12;

/** Must exceed STEP_MARGIN_PX, or every press re-selects the row just landed on. */
const PARKED_EPSILON_PX = STEP_MARGIN_PX + 4;

export type StepDirection = 'prev' | 'next';

const scrollPositionFor = (offset: number) => Math.max(0, offset - STEP_MARGIN_PX);

/** `offsets` are row tops relative to the scroll content, in document order. */
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

export function isStepStop(node: JsonlNode): boolean {
  return !(node.kind === 'user' && node.userKind === 'compact-summary');
}

export function isMainPrompt(node: JsonlNode): boolean {
  if (node.kind !== 'user' || node.userKind !== 'prompt') return false;
  if ((node.raw as { isSidechain?: boolean }).isSidechain === true) return false;
  return forwardedParentToolUseId(node.raw) === null;
}
