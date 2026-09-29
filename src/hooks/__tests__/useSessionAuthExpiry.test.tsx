// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';
import type { SessionStatus } from '@/lib/api';
import { announceAccountSignedIn } from '@/lib/accountSignIn';
import { useSessionAuthExpiry } from '../useSessionAuthExpiry';

const CONFIG_DIR = '/Users/me/.claude-personal';
const EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed';

function authFailed(timestamp: string): JsonlNode {
  return {
    kind: 'assistant',
    sessionId: 's1',
    receivedAt: timestamp,
    raw: {
      type: 'assistant',
      isSidechain: false,
      error: 'authentication_failed',
      message: { role: 'assistant', content: [{ type: 'text', text: EXPIRED }] },
      timestamp,
    } as never,
  };
}

interface Props {
  messages: JsonlNode[];
  sessionStatus: SessionStatus;
  turnRunning: boolean;
}

function setup(initial: Props) {
  const restart = vi.fn().mockResolvedValue(undefined);
  const hook = renderHook((p: Props) => useSessionAuthExpiry({ ...p, configDir: CONFIG_DIR, restart }), {
    initialProps: initial,
  });
  return { ...hook, restart };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-29T04:20:25Z'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useSessionAuthExpiry', () => {
  it('reports a failure the running process hit', () => {
    const { result, rerender } = setup({ messages: [], sessionStatus: 'started', turnRunning: false });
    rerender({ messages: [authFailed('2026-09-29T19:43:40Z')], sessionStatus: 'started', turnRunning: false });
    expect(result.current?.text).toBe(EXPIRED);
  });

  // A restored tab replays history that can end on an old failure. The
  // process now running is fresh and has not failed.
  it('ignores a failure older than the running process', () => {
    vi.setSystemTime(new Date('2026-09-29T20:04:32Z'));
    const { result } = setup({
      messages: [authFailed('2026-09-29T19:43:40Z')],
      sessionStatus: 'started',
      turnRunning: false,
    });
    expect(result.current).toBeNull();
  });

  it('reports nothing while no process is running', () => {
    const { result } = setup({
      messages: [authFailed('2026-09-29T19:43:40Z')],
      sessionStatus: 'stopped',
      turnRunning: false,
    });
    expect(result.current).toBeNull();
  });

  it('clears once the session restarts', () => {
    const failed = [authFailed('2026-09-29T19:43:40Z')];
    const { result, rerender } = setup({ messages: failed, sessionStatus: 'started', turnRunning: false });
    expect(result.current).not.toBeNull();

    vi.setSystemTime(new Date('2026-09-29T20:04:32Z'));
    rerender({ messages: failed, sessionStatus: 'stopped', turnRunning: false });
    rerender({ messages: failed, sessionStatus: 'started', turnRunning: false });
    expect(result.current).toBeNull();
  });

  it('restarts itself when its account is signed in again', () => {
    const { restart } = setup({
      messages: [authFailed('2026-09-29T19:43:40Z')],
      sessionStatus: 'started',
      turnRunning: false,
    });
    act(() => { announceAccountSignedIn(CONFIG_DIR); });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('ignores a sign-in to a different account', () => {
    const { restart } = setup({
      messages: [authFailed('2026-09-29T19:43:40Z')],
      sessionStatus: 'started',
      turnRunning: false,
    });
    act(() => { announceAccountSignedIn('/Users/me/.claude-work'); });
    expect(restart).not.toHaveBeenCalled();
  });

  it('does not restart a session that never lost its sign-in', () => {
    const { restart } = setup({ messages: [], sessionStatus: 'started', turnRunning: false });
    act(() => { announceAccountSignedIn(CONFIG_DIR); });
    expect(restart).not.toHaveBeenCalled();
  });

  it('leaves a session mid-turn alone', () => {
    const { restart } = setup({
      messages: [authFailed('2026-09-29T19:43:40Z')],
      sessionStatus: 'started',
      turnRunning: true,
    });
    act(() => { announceAccountSignedIn(CONFIG_DIR); });
    expect(restart).not.toHaveBeenCalled();
  });
});
