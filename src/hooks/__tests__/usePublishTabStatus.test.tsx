// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';
import type { Subagent } from '@/lib/subagentStreams';

const published: Array<Record<string, unknown>> = [];

vi.mock('@/lib/api', () => ({
  api: {
    publishTabStatus: (s: Record<string, unknown>) => { published.push(s); return Promise.resolve(); },
    removeTabStatus: () => Promise.resolve(),
  },
}));

const { usePublishTabStatus } = await import('../usePublishTabStatus');

const userPrompt = (): JsonlNode =>
  ({ kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '', raw: { type: 'user', message: { role: 'user', content: 'go' } } }) as unknown as JsonlNode;

// The turn that launched the agent, closed. `waitingOnClaude` reads this as
// settled — which is correct: the CLI is not mid-turn, the agent is.
const turnClosed = (): JsonlNode =>
  ({ kind: 'cli-stream-result', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'success' } }) as unknown as JsonlNode;

const runningAgent = (overrides: Partial<Subagent> = {}): Subagent =>
  ({
    toolUseId: 'toolu_1', description: 'Adversarial pre-push review', agentType: 'general-purpose',
    status: 'running', latest: null, events: [], colorIndex: 0, isBackground: true, ...overrides,
  }) as Subagent;

function publish(messages: JsonlNode[], subagents: Subagent[]) {
  renderHook(() =>
    usePublishTabStatus({
      tabId: 'tab-1', title: 't', projectPath: '/p', sessionStarted: true, isStarting: false,
      isLoading: false, hasError: false, messages, subagents, contextUsage: null,
      branch: null, filesChanged: 0, filesUntracked: 0, pendingPermission: null,
    }),
  );
  return published[published.length - 1];
}

describe('usePublishTabStatus — background agents outside the tab', () => {
  beforeEach(() => { published.length = 0; });

  it('keeps the tab reading "working" after the launching turn ends, while a background agent runs', () => {
    // The whole point of a backgrounded agent: the turn that launched it is
    // over, so `mainTurnInFlight` is false and nothing in the transcript is
    // pending. The tab strip's spinner and the status popover's busy count
    // both key off promptStatus, so this is the only thing telling the user
    // — from outside the tab — that work is still in flight.
    const summary = publish([userPrompt(), turnClosed()], [runningAgent()]);
    expect(summary.mainTurnInFlight).toBe(false);
    expect(summary.activeAgents).toBe(1);
    expect(summary.promptStatus).toBe('working');
    expect(summary.busy).toBe(true);
    expect(summary.status).toBe('busy');
  });

  it('goes back to ready once the agent reports its own completion', () => {
    const summary = publish([userPrompt(), turnClosed()], [runningAgent({ status: 'completed' })]);
    expect(summary.activeAgents).toBe(0);
    expect(summary.promptStatus).toBe('ready');
    expect(summary.status).toBe('idle');
  });

  it('counts a nested task owned by an agent as outstanding work too', () => {
    // A shell an agent backgrounds is still work the session is waiting on,
    // so it keeps the tab busy even though it renders indented under its
    // owner rather than as a top-level row.
    const summary = publish(
      [userPrompt(), turnClosed()],
      [
        runningAgent({ status: 'completed' }),
        runningAgent({ toolUseId: 'toolu_2', parentToolUseId: 'toolu_1', agentType: undefined, description: 'Run full shell test suite' }),
      ],
    );
    expect(summary.activeAgents).toBe(1);
    expect(summary.promptStatus).toBe('working');
  });
});
