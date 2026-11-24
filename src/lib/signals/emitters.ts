/** Pure derivations over state the session already holds: re-running them every render must yield the same signals. */

import type { JsonlNode } from '@/types/jsonl';
import type { McpServerConfigError } from '@/types/jsonl';
import type { CacheTtlChange } from '@/lib/cacheExpiry';
import { CACHE_TTL_1H_MS } from '@/lib/cacheExpiry';
import {
  contextPressureLevel,
  evaluateContextPressure,
  formatTokens,
  resolveBudgetTokens,
  type ContextPressureSetting,
} from '@/lib/contextPressure';
import {
  clampJumpTokens,
  turnDeltaSeries,
  type ContextJumpSetting,
} from '@/lib/turnDelta';
import { deriveThinkingStatus, lastTurnThinkingTokens } from '@/lib/thinkingStatus';
import type { SessionSignal, SignalAction } from './types';

export const BOUNDARY_SNOOZE_TOKENS = 20_000;

export type SessionActivity = 'thinking' | 'active' | 'idle' | 'usage-limit' | 'stopped';

/** Structural, to avoid an api.ts cycle. */
export interface AccountMismatchFacts {
  expected: string;
  detected: string | null;
  configDir: string;
}

export interface SignalHandlers {
  onCompact: () => void;
  onSnoozeBoundary: () => void;
  onRaiseContextBudget: (tokens: number) => void;
  onRestartSession: () => void;
}

export interface SignalInput {
  tabId: string;
  messages: JsonlNode[];
  contextTokens: number;
  contextLimit: number;
  pressureSetting: ContextPressureSetting;
  jumpSetting: ContextJumpSetting;
  boundarySnoozeTokens: number;
  sessionLive: boolean;
  turnInFlight: boolean;
  /** Measured at the isLoading transition, not from `duration_ms`: two clocks would make the status bar jump when it stops. */
  turnStartedAt: number | null;
  lastTurnMs: number | null;
  cacheTtlChange: CacheTtlChange | null;
  mcpErrors: McpServerConfigError[] | null;
  /** Epoch SECONDS, matching `usageLimitWait`. */
  usageLimitResetsAt: number | null;
  accountMismatch: AccountMismatchFacts | null;
  accountRestartable: boolean;
  handlers: SignalHandlers;
}

export function deriveSessionSignals(input: SignalInput): SessionSignal[] {
  return [
    activitySignal(input),
    contextLevelSignal(input),
    ...contextDeltaEvents(input),
    ...boundaryAction(input),
    ...cacheTtlEvent(input),
    ...mcpSkippedEvents(input),
    ...accountMismatchAction(input),
  ];
}

/** A second pill: `sessionStatus` is the main process's, and no renderer store may keep its own copy. */
function activitySignal(input: SignalInput): SessionSignal {
  const { messages, sessionLive, turnInFlight, usageLimitResetsAt } = input;
  const thinking = turnInFlight ? deriveThinkingStatus(messages) : null;

  const status: SessionActivity = !sessionLive
    ? 'stopped'
    : usageLimitResetsAt !== null
      ? 'usage-limit'
      : thinking
        ? 'thinking'
        : turnInFlight
          ? 'active'
          : 'idle';

  return {
    id: 'session.activity',
    tabId: input.tabId,
    kind: 'state',
    anchor: 'session',
    priority: 'low',
    key: 'session.activity',
    title: status,
    at: 0,
    meta: {
      status,
      thinkingTokens: thinking?.tokens ?? null,
      startedAt: thinking?.startedAt ?? null,
      resetsAt: usageLimitResetsAt,
      turnStartedAt: turnInFlight ? input.turnStartedAt : null,
      lastTurnMs: input.lastTurnMs,
      turnThinkingTokens: lastTurnThinkingTokens(messages),
    },
  };
}

/** Gated on `sessionLive`: a transcript opened from disk must not announce a days-old jump. */
function contextDeltaEvents(input: SignalInput): SessionSignal[] {
  const { messages, sessionLive, jumpSetting, tabId } = input;
  if (!sessionLive || !jumpSetting.enabled) return [];

  const threshold = clampJumpTokens(jumpSetting.thresholdTokens);

  return turnDeltaSeries(messages).map((entry) => {
    const compacted = entry.compacted;
    const key = compacted ? 'context.compacted' : 'context.delta';
    const magnitude = formatTokens(Math.abs(entry.deltaTokens));

    return {
      id: `${key}:${entry.anchorId}`,
      tabId,
      kind: 'event' as const,
      anchor: 'session' as const,
      priority: 'normal' as const,
      key,
      title: compacted
        ? `Compacted — released ${magnitude}`
        : `${entry.deltaTokens >= 0 ? '+' : '−'}${magnitude} of context`,
      detail: `${formatTokens(entry.prevTotal)} → ${formatTokens(entry.newTotal)}`,
      at: entry.at,
      ...(entry.promptUuid ? { messageUuid: entry.promptUuid } : {}),
      meta: {
        before: entry.prevTotal,
        after: entry.newTotal,
        delta: entry.deltaTokens,
        compacted,
        isJump: !compacted && entry.deltaTokens >= threshold,
      },
    };
  });
}

/** Emitted even at level `none`, so the meter always has a color matching the boundary action. */
function contextLevelSignal(input: SignalInput): SessionSignal {
  const { contextTokens, contextLimit, pressureSetting, boundarySnoozeTokens, tabId } = input;
  const setting = withSnooze(pressureSetting, contextLimit, boundarySnoozeTokens);
  const budgetTokens = contextLimit > 0 ? resolveBudgetTokens(setting, contextLimit) : 0;
  const level = contextPressureLevel({ tokens: contextTokens, limit: contextLimit, setting });
  const pct = contextLimit > 0 ? Math.min(100, (contextTokens / contextLimit) * 100) : 0;

  return {
    id: 'context.level',
    tabId,
    kind: 'state',
    anchor: 'session',
    priority: 'low',
    key: 'context.level',
    title: level,
    at: 0,
    meta: {
      level,
      tokens: contextTokens,
      limit: contextLimit,
      budgetTokens,
      pct,
      budgetPct: contextLimit > 0 ? Math.min(100, (budgetTokens / contextLimit) * 100) : 0,
    },
  };
}

/** The Snooze offset is applied to the budget here, not as a store flag: that is what makes re-arm automatic. */
function boundaryAction(input: SignalInput): SessionSignal[] {
  const {
    contextTokens,
    contextLimit,
    pressureSetting,
    boundarySnoozeTokens,
    sessionLive,
    turnInFlight,
    handlers,
    tabId,
  } = input;

  const setting = withSnooze(pressureSetting, contextLimit, boundarySnoozeTokens);
  const pressure = evaluateContextPressure({
    tokens: contextTokens,
    limit: contextLimit,
    setting,
    sessionLive,
  });
  // Only `critical` is a call to action; `warn` is already the meter's color.
  if (pressure.level !== 'critical') return [];

  const actions: SignalAction[] = [
    {
      id: 'compact',
      label: 'Compact now',
      primary: true,
      // /compact cannot run mid-turn.
      disabled: turnInFlight,
      run: handlers.onCompact,
    },
    {
      id: 'snooze',
      label: `Snooze (+${formatTokens(BOUNDARY_SNOOZE_TOKENS)})`,
      run: handlers.onSnoozeBoundary,
    },
    {
      id: 'raise',
      label: 'Raise limit',
      run: () => { handlers.onRaiseContextBudget(pressure.budgetTokens + BOUNDARY_SNOOZE_TOKENS); },
    },
  ];

  return [
    {
      id: 'context.boundary',
      tabId,
      kind: 'action',
      anchor: 'session',
      priority: 'high',
      key: 'context.boundary',
      title: `Context past your ${formatTokens(pressure.budgetTokens)} budget`,
      detail: `${formatTokens(contextTokens)} / ${formatTokens(contextLimit)} (${Math.round(pressure.pct)}%)`,
      at: 0,
      actions,
      meta: {
        level: pressure.level,
        budgetTokens: pressure.budgetTokens,
        tokens: contextTokens,
        limit: contextLimit,
        pct: pressure.pct,
        snoozedBy: boundarySnoozeTokens,
      },
    },
  ];
}

/** Absolute tokens even for a percentage setting, so a snooze buys the same headroom on any window size. */
function withSnooze(
  setting: ContextPressureSetting,
  limit: number,
  snoozeTokens: number,
): ContextPressureSetting {
  if (snoozeTokens <= 0) return setting;
  return {
    ...setting,
    mode: 'tokens',
    value: resolveBudgetTokens(setting, limit) + snoozeTokens,
  };
}

function cacheTtlEvent(input: SignalInput): SessionSignal[] {
  const { cacheTtlChange, tabId } = input;
  if (!cacheTtlChange) return [];

  const label = (ms: number) => (ms === CACHE_TTL_1H_MS ? '1h' : '5m');
  const shrank = cacheTtlChange.toMs < cacheTtlChange.fromMs;

  return [
    {
      id: `cache.ttl:${cacheTtlChange.fromMs}->${cacheTtlChange.toMs}`,
      tabId,
      kind: 'event',
      anchor: 'session',
      priority: 'normal',
      key: 'cache.ttl',
      title: `Prompt cache TTL ${label(cacheTtlChange.fromMs)} → ${label(cacheTtlChange.toMs)}`,
      detail: shrank ? 'Usually means usage overage.' : undefined,
      at: 0,
      meta: { fromMs: cacheTtlChange.fromMs, toMs: cacheTtlChange.toMs },
    },
  ];
}

function mcpSkippedEvents(input: SignalInput): SessionSignal[] {
  const { mcpErrors, tabId } = input;
  if (!mcpErrors?.length) return [];

  return mcpErrors.map((error) => ({
    id: `mcp.skipped:${error.name}`,
    tabId,
    kind: 'event' as const,
    anchor: 'mcp' as const,
    priority: 'normal' as const,
    key: `mcp.skipped.${error.name}`,
    title: `${error.name} was skipped`,
    detail: error.message || error.type,
    at: 0,
    meta: { server: error.name, type: error.type },
  }));
}

function accountMismatchAction(input: SignalInput): SessionSignal[] {
  const { accountMismatch, accountRestartable, handlers, tabId } = input;
  if (!accountMismatch) return [];

  return [
    {
      id: 'account.mismatch',
      tabId,
      kind: 'action',
      anchor: 'account',
      priority: 'high',
      key: 'account.mismatch',
      title: `Session expects ${accountMismatch.expected}`,
      detail: accountMismatch.detected
        ? `${accountMismatch.configDir} is signed in as ${accountMismatch.detected}.`
        : `${accountMismatch.configDir} is not signed in.`,
      at: 0,
      // Empty, not absent: a restart would change nothing.
      actions: accountRestartable
        ? [{ id: 'restart', label: 'Restart session', primary: true, run: handlers.onRestartSession }]
        : [],
      meta: {
        expected: accountMismatch.expected,
        detected: accountMismatch.detected,
        configDir: accountMismatch.configDir,
      },
    },
  ];
}
