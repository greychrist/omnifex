import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { CACHE_TTL_1H_MS, CACHE_TTL_5M_MS } from '@/lib/cacheExpiry';
import { DEFAULT_CONTEXT_JUMP } from '@/lib/turnDelta';
import { DEFAULT_CONTEXT_PRESSURE } from '@/lib/contextPressure';
import {
  BOUNDARY_SNOOZE_TOKENS,
  deriveSessionSignals,
  type SignalInput,
} from '../emitters';

const assistant = (total: number, receivedAt = '2026-09-11T10:00:00Z'): JsonlNode =>
  ({
    kind: 'assistant',
    sessionId: 's1',
    receivedAt,
    raw: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [],
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: total - 3,
          cache_creation_input_tokens: 1,
          output_tokens: 1,
        },
      },
    },
  }) as unknown as JsonlNode;

const prompt = (uuid: string): JsonlNode =>
  ({
    kind: 'user',
    sessionId: 's1',
    receivedAt: '2026-09-11T10:00:00Z',
    userKind: 'prompt',
    raw: { type: 'user', uuid, message: { role: 'user', content: 'hi' } },
  }) as unknown as JsonlNode;

const compactBoundary = (): JsonlNode =>
  ({
    kind: 'system',
    subtype: 'compact_boundary',
    sessionId: 's1',
    receivedAt: '2026-09-11T10:00:00Z',
    raw: { type: 'system', subtype: 'compact_boundary' },
  }) as unknown as JsonlNode;

const thinkingPing = (tokens: number, receivedAt: string): JsonlNode =>
  ({
    kind: 'system',
    subtype: 'thinking_tokens',
    sessionId: 's1',
    receivedAt,
    raw: { type: 'system', subtype: 'thinking_tokens', estimated_tokens: tokens },
  }) as unknown as JsonlNode;

const noop = () => {};

function input(over: Partial<SignalInput> = {}): SignalInput {
  return {
    tabId: 'tab-1',
    messages: [],
    contextTokens: 0,
    contextLimit: 1_000_000,
    pressureSetting: DEFAULT_CONTEXT_PRESSURE,
    jumpSetting: DEFAULT_CONTEXT_JUMP,
    boundarySnoozeTokens: 0,
    sessionLive: true,
    turnInFlight: false,
    cacheTtlChange: null,
    mcpErrors: null,
    usageLimitResetsAt: null,
    accountMismatch: null,
    accountRestartable: false,
    handlers: {
      onCompact: noop,
      onSnoozeBoundary: noop,
      onRaiseContextBudget: noop,
      onRestartSession: noop,
    },
    ...over,
  };
}

const byKey = (signals: ReturnType<typeof deriveSessionSignals>, key: string) =>
  signals.filter((s) => s.key === key);

describe('deriveSessionSignals — session activity', () => {
  it('reports thinking with the burst total and its start time', () => {
    const signals = deriveSessionSignals(
      input({
        messages: [thinkingPing(1300, '2026-09-11T10:00:00Z')],
        turnInFlight: true,
      }),
    );

    const activity = byKey(signals, 'session.activity')[0];
    expect(activity.kind).toBe('state');
    expect(activity.meta).toMatchObject({
      status: 'thinking',
      thinkingTokens: 1300,
      startedAt: Date.parse('2026-09-11T10:00:00Z'),
    });
  });

  it('does not claim a session is thinking once the turn has ended', () => {
    // An interrupted turn leaves a thinking ping as the permanent tail of the
    // transcript; without the turn gate the pill would say "thinking" forever.
    const signals = deriveSessionSignals(
      input({ messages: [thinkingPing(1300, '2026-09-11T10:00:00Z')], turnInFlight: false }),
    );

    expect(byKey(signals, 'session.activity')[0].meta?.status).toBe('idle');
  });

  it('reports a usage-limit park as its own activity, not as idle', () => {
    const signals = deriveSessionSignals(
      input({ turnInFlight: true, usageLimitResetsAt: 1_800_000_000 }),
    );

    const activity = byKey(signals, 'session.activity')[0];
    expect(activity.meta).toMatchObject({ status: 'usage-limit', resetsAt: 1_800_000_000 });
  });

  it('reports a stopped session, so the pill is never stale', () => {
    const signals = deriveSessionSignals(input({ sessionLive: false }));
    expect(byKey(signals, 'session.activity')[0].meta?.status).toBe('stopped');
  });
});

describe('deriveSessionSignals — context delta events', () => {
  const messages = [assistant(100_000), prompt('p1'), assistant(180_000), prompt('p2'), assistant(190_000)];

  it('emits one event per turn, identified by the prompt that caused it', () => {
    const signals = deriveSessionSignals(input({ messages }));
    const deltas = byKey(signals, 'context.delta');

    expect(deltas.map((d) => d.id)).toEqual(['context.delta:p1', 'context.delta:p2']);
    expect(deltas.every((d) => d.kind === 'event')).toBe(true);
    expect(deltas[0].meta).toMatchObject({ before: 100_000, after: 180_000, delta: 80_000 });
  });

  it('flags a delta over the threshold so the row can be coloured', () => {
    const signals = deriveSessionSignals(input({ messages }));
    const deltas = byKey(signals, 'context.delta');

    expect(deltas[0].meta?.isJump).toBe(true);
    expect(deltas[1].meta?.isJump).toBe(false);
  });

  it('emits nothing when the user has turned context-jump reporting off', () => {
    const signals = deriveSessionSignals(
      input({ messages, jumpSetting: { ...DEFAULT_CONTEXT_JUMP, enabled: false } }),
    );

    expect(byKey(signals, 'context.delta')).toHaveLength(0);
  });

  it('separates a compaction into its own key', () => {
    const signals = deriveSessionSignals(
      input({ messages: [assistant(500_000), prompt('p1'), compactBoundary(), assistant(80_000)] }),
    );

    expect(byKey(signals, 'context.delta')).toHaveLength(0);
    const compacted = byKey(signals, 'context.compacted')[0];
    expect(compacted.meta).toMatchObject({ before: 500_000, after: 80_000, delta: -420_000 });
  });

  it('stays silent on a transcript loaded from a dead session', () => {
    // A history opened from disk must not announce jumps that happened days ago.
    expect(byKey(deriveSessionSignals(input({ messages, sessionLive: false })), 'context.delta')).toHaveLength(0);
  });
});

describe('deriveSessionSignals — context boundary', () => {
  const overBudget = input({ contextTokens: 260_000, contextLimit: 1_000_000 });

  it('raises a high-priority action with compact, snooze and raise-limit', () => {
    const boundary = byKey(deriveSessionSignals(overBudget), 'context.boundary')[0];

    expect(boundary.kind).toBe('action');
    expect(boundary.priority).toBe('high');
    expect(boundary.actions?.map((a) => a.id)).toEqual(['compact', 'snooze', 'raise']);
    expect(boundary.actions?.find((a) => a.primary)?.id).toBe('compact');
  });

  it('carries the budget and the compact-at percentage for the popover header', () => {
    const boundary = byKey(deriveSessionSignals(overBudget), 'context.boundary')[0];
    expect(boundary.meta).toMatchObject({ budgetTokens: 250_000, tokens: 260_000, limit: 1_000_000 });
  });

  it('stands down once a snooze has raised the budget past the current usage', () => {
    const snoozed = deriveSessionSignals({ ...overBudget, boundarySnoozeTokens: BOUNDARY_SNOOZE_TOKENS });
    expect(byKey(snoozed, 'context.boundary')).toHaveLength(0);
  });

  it('re-arms after a snooze once the raised budget is crossed too', () => {
    const snoozed = deriveSessionSignals({
      ...overBudget,
      contextTokens: 280_000,
      boundarySnoozeTokens: BOUNDARY_SNOOZE_TOKENS,
    });

    expect(byKey(snoozed, 'context.boundary')).toHaveLength(1);
    expect(byKey(snoozed, 'context.boundary')[0].meta?.budgetTokens).toBe(270_000);
  });

  it('never asks a dead session to compact itself', () => {
    expect(byKey(deriveSessionSignals({ ...overBudget, sessionLive: false }), 'context.boundary')).toHaveLength(0);
  });

  it('leaves the compact action inert while a turn is in flight', () => {
    const boundary = byKey(deriveSessionSignals({ ...overBudget, turnInFlight: true }), 'context.boundary')[0];
    expect(boundary.actions?.find((a) => a.id === 'compact')?.disabled).toBe(true);
  });
});

describe('deriveSessionSignals — the other migrated notices', () => {
  it('logs a cache-TTL change as one event, keyed to the transition', () => {
    const signals = deriveSessionSignals(
      input({ cacheTtlChange: { fromMs: CACHE_TTL_1H_MS, toMs: CACHE_TTL_5M_MS } }),
    );

    const ttl = byKey(signals, 'cache.ttl')[0];
    expect(ttl.kind).toBe('event');
    expect(ttl.id).toBe(`cache.ttl:${CACHE_TTL_1H_MS}->${CACHE_TTL_5M_MS}`);
    expect(ttl.detail).toMatch(/overage/i);
  });

  it('routes skipped MCP servers to the MCP badge, one event each', () => {
    const signals = deriveSessionSignals(
      input({
        mcpErrors: [
          { name: 'github', type: 'config_error', message: 'bad token' },
          { name: 'jira', type: 'config_error', message: '' },
        ],
      }),
    );

    const skipped = signals.filter((s) => s.anchor === 'mcp');
    expect(skipped.map((s) => s.key)).toEqual(['mcp.skipped.github', 'mcp.skipped.jira']);
    // The CLI's own message names the offending field; paraphrasing loses it.
    expect(skipped[0].detail).toBe('bad token');
    expect(skipped[1].detail).toBe('config_error');
  });

  it('anchors an account mismatch to the account widget with a restart action', () => {
    const signals = deriveSessionSignals(
      input({
        accountMismatch: { expected: 'a@b.com', detected: 'c@d.com', configDir: '/cfg' },
        accountRestartable: true,
      }),
    );

    const mismatch = byKey(signals, 'account.mismatch')[0];
    expect(mismatch.anchor).toBe('account');
    expect(mismatch.kind).toBe('action');
    expect(mismatch.actions?.map((a) => a.id)).toEqual(['restart']);
  });

  it('offers no restart when restarting would change nothing', () => {
    const signals = deriveSessionSignals(
      input({
        accountMismatch: { expected: 'a@b.com', detected: 'c@d.com', configDir: '/cfg' },
        accountRestartable: false,
      }),
    );

    expect(byKey(signals, 'account.mismatch')[0].actions).toEqual([]);
  });
});
