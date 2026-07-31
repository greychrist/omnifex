import { describe, it, expect } from 'vitest';
import { STEP_MARGIN_PX, stepTarget, isStepStop, isMainPrompt } from '../transcriptStepper';
import type { JsonlNode } from '@/types/jsonl';
import type { UserKind } from '@/types/jsonl';

const user = (userKind: UserKind, raw: Record<string, unknown> = {}): JsonlNode => ({
  kind: 'user',
  userKind,
  sessionId: 's',
  receivedAt: '2026-07-30T00:00:00.000Z',
  raw: {
    type: 'user',
    message: { role: 'user', content: 'hi' },
    ...raw,
  } as never,
});

const assistant = (): JsonlNode => ({
  kind: 'assistant',
  sessionId: 's',
  receivedAt: '2026-07-30T00:00:00.000Z',
  raw: { type: 'assistant', message: { role: 'assistant', content: [] } } as never,
});

// Row tops as measured from the top of the scroll container's content.
const ROWS = [0, 500, 1200, 2000];

describe('stepTarget', () => {
  it('goes to the row below the current position', () => {
    expect(stepTarget({ offsets: ROWS, scrollTop: 0, direction: 'next' })).toBe(
      500 - STEP_MARGIN_PX,
    );
  });

  it('goes to the row above the current position', () => {
    expect(stepTarget({ offsets: ROWS, scrollTop: 1400, direction: 'prev' })).toBe(
      1200 - STEP_MARGIN_PX,
    );
  });

  // The whole point of the epsilon. Landing on a row parks the viewport a
  // margin ABOVE that row's top, so without slack the row you just arrived at
  // still counts as "below you" and every press re-selects it.
  it('does not re-select the row it just landed on', () => {
    const first = stepTarget({ offsets: ROWS, scrollTop: 0, direction: 'next' });
    expect(first).not.toBeNull();
    expect(stepTarget({ offsets: ROWS, scrollTop: first as number, direction: 'next' })).toBe(
      1200 - STEP_MARGIN_PX,
    );
  });

  it('steps back off the row it just landed on', () => {
    const landed = 1200 - STEP_MARGIN_PX;
    expect(stepTarget({ offsets: ROWS, scrollTop: landed, direction: 'prev' })).toBe(
      500 - STEP_MARGIN_PX,
    );
  });

  it('returns null past the last row', () => {
    expect(stepTarget({ offsets: ROWS, scrollTop: 2500, direction: 'next' })).toBeNull();
  });

  it('returns null above the first row', () => {
    expect(stepTarget({ offsets: ROWS, scrollTop: 0, direction: 'prev' })).toBeNull();
  });

  it('returns null when there are no rows', () => {
    expect(stepTarget({ offsets: [], scrollTop: 0, direction: 'next' })).toBeNull();
    expect(stepTarget({ offsets: [], scrollTop: 0, direction: 'prev' })).toBeNull();
  });

  // The first row sits at offset 0, so `offset - margin` is negative. Handing
  // a negative scrollTop to scrollTo is silently clamped by the browser, but
  // the round-trip tests above depend on the value being the one we can be
  // scrolled back to.
  it('never returns a negative scroll position', () => {
    expect(stepTarget({ offsets: ROWS, scrollTop: 400, direction: 'prev' })).toBe(0);
  });

  it('picks up from a position the user scrolled to by hand', () => {
    expect(stepTarget({ offsets: ROWS, scrollTop: 700, direction: 'next' })).toBe(
      1200 - STEP_MARGIN_PX,
    );
    expect(stepTarget({ offsets: ROWS, scrollTop: 700, direction: 'prev' })).toBe(
      500 - STEP_MARGIN_PX,
    );
  });
});

// Prompt navigation runs the same stepping over a sparser offset list, so
// there is no second algorithm — only a second selector at the call site.
describe('stepTarget over prompts only', () => {
  const PROMPTS = [0, 900, 4200];

  it('skips the rows between two prompts', () => {
    expect(stepTarget({ offsets: PROMPTS, scrollTop: 0, direction: 'next' })).toBe(
      900 - STEP_MARGIN_PX,
    );
  });

  it('walks back to the prompt above', () => {
    expect(stepTarget({ offsets: PROMPTS, scrollTop: 3000, direction: 'prev' })).toBe(
      900 - STEP_MARGIN_PX,
    );
  });

  it('stops at the newest prompt', () => {
    expect(stepTarget({ offsets: PROMPTS, scrollTop: 4200, direction: 'next' })).toBeNull();
  });
});

// The stop set is "everything you can land on". A /compact summary is carved
// out because it is machinery, not conversation — it is the one row the user
// asked to be able to skip past.
describe('isStepStop', () => {
  it('stops on an assistant message', () => {
    expect(isStepStop(assistant())).toBe(true);
  });

  it('stops on a prompt', () => {
    expect(isStepStop(user('prompt'))).toBe(true);
  });

  it('stops on a tool result', () => {
    expect(isStepStop(user('tool-result'))).toBe(true);
  });

  it('skips a compact summary', () => {
    expect(isStepStop(user('compact-summary'))).toBe(false);
  });
});

describe('isMainPrompt', () => {
  it('accepts a main-thread prompt', () => {
    expect(isMainPrompt(user('prompt'))).toBe(true);
  });

  it('rejects an assistant message', () => {
    expect(isMainPrompt(assistant())).toBe(false);
  });

  it('rejects a compact summary', () => {
    expect(isMainPrompt(user('compact-summary'))).toBe(false);
  });

  it('rejects a meta/skill-injection user row', () => {
    expect(isMainPrompt(user('meta-skill'))).toBe(false);
  });

  // A forwarded subagent prompt is a `user` prompt row, but it is the
  // subagent's prompt, not Greg's — "jump to my last prompt" must not land
  // on one. Same exclusion the turn-anchor derivations already make.
  it('rejects a forwarded subagent prompt', () => {
    expect(isMainPrompt(user('prompt', { parent_tool_use_id: 'toolu_123' }))).toBe(false);
  });
});
