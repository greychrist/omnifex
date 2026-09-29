// @vitest-environment node
//
// Auto-recap: when a turn finishes and nobody answers for a while, send the
// CLI's own `/recap` once, so a user coming back to the tab reads where
// things stand. The CLI's own away-summaries are TUI-focus-gated and never
// reach a stream-json host (see the away_summary memory note).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createAutoRecap,
  readAutoRecapPolicy,
  type AutoRecapPolicy,
} from '../services/sessions/auto-recap';
import { AUTO_RECAP_ENABLED_KEY, AUTO_RECAP_DELAY_KEY } from '../../src/lib/autoRecapSettings';

const MIN = 60_000;

describe('readAutoRecapPolicy', () => {
  const read = (rows: Record<string, string>) => readAutoRecapPolicy((k) => rows[k] ?? null);

  it('defaults to on, after 5 minutes', () => {
    expect(read({})).toEqual({ enabled: true, delayMs: 5 * MIN });
  });

  it('reads the stored switch and delay', () => {
    expect(read({ [AUTO_RECAP_ENABLED_KEY]: 'false', [AUTO_RECAP_DELAY_KEY]: '12' }))
      .toEqual({ enabled: false, delayMs: 12 * MIN });
  });

  it('falls back to 5 minutes for a delay that is not a positive number', () => {
    expect(read({ [AUTO_RECAP_DELAY_KEY]: 'soon' }).delayMs).toBe(5 * MIN);
    expect(read({ [AUTO_RECAP_DELAY_KEY]: '0' }).delayMs).toBe(5 * MIN);
  });
});

describe('createAutoRecap', () => {
  let policy: AutoRecapPolicy;
  let sent: string[];
  let canSend: boolean;
  let recap: ReturnType<typeof createAutoRecap>;

  beforeEach(() => {
    vi.useFakeTimers();
    policy = { enabled: true, delayMs: 5 * MIN };
    sent = [];
    canSend = true;
    recap = createAutoRecap({
      policy: () => policy,
      canSend: () => canSend,
      send: (tabId) => { sent.push(tabId); },
    });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('sends /recap once the turn has sat idle for the delay', () => {
    recap.onTurn('t1', 'running');
    recap.onTurn('t1', 'idle');
    vi.advanceTimersByTime(5 * MIN - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(['t1']);
  });

  it('cancels when the user answers before the delay', () => {
    recap.onTurn('t1', 'idle');
    vi.advanceTimersByTime(2 * MIN);
    recap.noteUserSend('t1');
    recap.onTurn('t1', 'running');
    vi.advanceTimersByTime(10 * MIN);
    expect(sent).toEqual([]);
  });

  // Once per turn: the recap is itself a turn, and its ending must not arm
  // another recap — or an idle tab would recap itself every five minutes.
  it('does not recap the recap', () => {
    recap.onTurn('t1', 'idle');
    vi.advanceTimersByTime(5 * MIN);
    recap.onTurn('t1', 'running'); // the /recap turn
    recap.onTurn('t1', 'idle');
    vi.advanceTimersByTime(60 * MIN);
    expect(sent).toEqual(['t1']);
  });

  it('recaps the next real turn after a recap', () => {
    recap.onTurn('t1', 'idle');
    vi.advanceTimersByTime(5 * MIN);
    recap.onTurn('t1', 'running');
    recap.onTurn('t1', 'idle'); // recap done
    recap.noteUserSend('t1');
    recap.onTurn('t1', 'running');
    recap.onTurn('t1', 'idle');
    vi.advanceTimersByTime(5 * MIN);
    expect(sent).toEqual(['t1', 't1']);
  });

  // A prompt typed while the recap runs joins that turn; the combined turn
  // ending is a real turn and earns its own recap.
  it('treats a turn the user joined as a real turn', () => {
    recap.onTurn('t1', 'idle');
    vi.advanceTimersByTime(5 * MIN);
    recap.onTurn('t1', 'running');
    recap.noteUserSend('t1');
    recap.onTurn('t1', 'idle');
    vi.advanceTimersByTime(5 * MIN);
    expect(sent).toEqual(['t1', 't1']);
  });

  it('reads the policy when the timer fires, so turning it off stops a pending recap', () => {
    recap.onTurn('t1', 'idle');
    policy = { enabled: false, delayMs: 5 * MIN };
    vi.advanceTimersByTime(5 * MIN);
    expect(sent).toEqual([]);
  });

  it('arms nothing while disabled', () => {
    policy = { enabled: false, delayMs: 5 * MIN };
    recap.onTurn('t1', 'idle');
    policy = { enabled: true, delayMs: 5 * MIN };
    vi.advanceTimersByTime(60 * MIN);
    expect(sent).toEqual([]);
  });

  it('skips a session that can no longer take a prompt (stopped, errored, busy)', () => {
    recap.onTurn('t1', 'idle');
    canSend = false;
    vi.advanceTimersByTime(5 * MIN);
    expect(sent).toEqual([]);
  });

  it('forgets a closed tab', () => {
    recap.onTurn('t1', 'idle');
    recap.forget('t1');
    vi.advanceTimersByTime(60 * MIN);
    expect(sent).toEqual([]);
  });

  // The countdown measures quiet, not time since the turn closed: anything
  // the CLI says afterwards (a background agent reporting in, its wake-up
  // turn) restarts it.
  it('restarts the countdown on every message that arrives while idle', () => {
    recap.onTurn('t1', 'idle');
    vi.advanceTimersByTime(4 * MIN);
    recap.onActivity('t1');
    vi.advanceTimersByTime(4 * MIN);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1 * MIN);
    expect(sent).toEqual(['t1']);
  });

  it('ignores activity mid-turn and before any turn has ended', () => {
    recap.onActivity('t1');
    recap.onTurn('t1', 'running');
    recap.onActivity('t1');
    vi.advanceTimersByTime(60 * MIN);
    expect(sent).toEqual([]);
  });

  it('does not re-arm from messages after the recap itself', () => {
    recap.onTurn('t1', 'idle');
    vi.advanceTimersByTime(5 * MIN);
    recap.onTurn('t1', 'running');
    recap.onTurn('t1', 'idle');
    recap.onActivity('t1');
    vi.advanceTimersByTime(60 * MIN);
    expect(sent).toEqual(['t1']);
  });

  // Background work still running blocks the send, but the turn has not had
  // its recap: the task's own completion message restarts the countdown.
  it('waits out background work, then counts down from its last message', () => {
    recap.onTurn('t1', 'idle');
    canSend = false;
    vi.advanceTimersByTime(5 * MIN);
    expect(sent).toEqual([]);
    canSend = true;
    recap.onActivity('t1'); // task_notification
    vi.advanceTimersByTime(5 * MIN - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(['t1']);
  });

  it('keeps tabs independent', () => {
    recap.onTurn('t1', 'idle');
    vi.advanceTimersByTime(3 * MIN);
    recap.onTurn('t2', 'idle');
    recap.onTurn('t1', 'running');
    vi.advanceTimersByTime(5 * MIN);
    expect(sent).toEqual(['t2']);
  });
});
