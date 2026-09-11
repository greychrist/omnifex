/**
 * The one place that turns session facts into signals.
 *
 * Every emitter here is a **pure derivation over state the session already
 * holds** — the message array, the resolved context numbers, the settings.
 * Nothing subscribes, nothing is pushed, nothing is remembered. That is not an
 * implementation detail, it is the property the store depends on: re-running
 * this on every render must produce the same signals, so `emit` can be
 * idempotent and the whole model self-clears when a condition ends.
 *
 * It also means remote mode needs no special path. A session resumed from the
 * daemon replays the stream, the stream produces the messages, and the same
 * derivation rebuilds every `state` signal for free.
 *
 * See docs/superpowers/specs/2026-09-11-session-signals-design.md
 */

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
import { deriveThinkingStatus } from '@/lib/thinkingStatus';
import type { SessionSignal, SignalAction } from './types';

/** How much headroom one Snooze buys. Additive across presses. */
export const BOUNDARY_SNOOZE_TOKENS = 20_000;

/** What the session-activity pill is currently reporting. */
export type SessionActivity = 'thinking' | 'active' | 'idle' | 'usage-limit' | 'stopped';

/** Shape of an account mismatch, structurally matched to avoid an api.ts cycle. */
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
  /** Resolved occupancy — the same number the gauge renders. */
  contextTokens: number;
  contextLimit: number;
  pressureSetting: ContextPressureSetting;
  jumpSetting: ContextJumpSetting;
  /** Accumulated Snooze offset for this tab, from the store. */
  boundarySnoozeTokens: number;
  /** `sessionStatus === 'started'` — is the CLI actually up? */
  sessionLive: boolean;
  /** Is a main turn in flight right now? */
  turnInFlight: boolean;
  cacheTtlChange: CacheTtlChange | null;
  mcpErrors: McpServerConfigError[] | null;
  /** Epoch SECONDS, matching `usageLimitWait`. */
  usageLimitResetsAt: number | null;
  accountMismatch: AccountMismatchFacts | null;
  /** True only when restarting would actually change the credentials in use. */
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

/**
 * The activity pill's value — deliberately a *second* pill, not a rewrite of
 * the existing session-status one.
 *
 * `sessionStatus` (is the CLI process up?) is owned by the main process and
 * mirrored by `useSessionLifecycle`; docs/session-lifecycle.md forbids a
 * renderer store keeping its own copy. So this reports the orthogonal axis —
 * what the session is *doing* — and the two pills stack rather than merge.
 */
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
      // Zero-arg fields rather than a union, so the pill can read one shape.
      thinkingTokens: thinking?.tokens ?? null,
      startedAt: thinking?.startedAt ?? null,
      resetsAt: usageLimitResetsAt,
    },
  };
}

/**
 * One event per turn, so the popover is a log rather than a single alarm.
 *
 * Gated on `sessionLive` for the same reason the old notices were: a transcript
 * opened from disk must not announce a jump that happened days ago. Gated on
 * `jumpSetting.enabled` because that switch has always meant "stop telling me
 * about context growth", and routing it to a badge instead of a banner does
 * not change what the user asked for.
 */
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

/**
 * Where context sits against the budget — the meter's colour, as a state.
 *
 * This is the `warn` half of what the old banner did. The banner escalated in
 * two steps (amber at 80% of budget, red at 100%) because a banner was the only
 * surface it had; with signals the two steps are different *kinds*. "Getting
 * full" is a value, so it tints the meter in place. "Do something about it" is
 * a call to action, so it goes to the attention slot — and only at `critical`.
 * Nothing is lost, both halves are just anchored to the thing they describe.
 *
 * Emitted even at level `none` so the meter always has a colour to read, and
 * always the one the boundary action agrees with.
 */
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
      /** Where on the meter the budget sits — the "compact at N%" readout. */
      budgetPct: contextLimit > 0 ? Math.min(100, (budgetTokens / contextLimit) * 100) : 0,
    },
  };
}

/**
 * The compaction boundary, as the one call to action context can raise.
 *
 * The Snooze offset is applied *here*, to the budget, rather than being a
 * suppression flag in the store. That is what makes re-arm automatic: raise the
 * budget by 20k and the action simply stops evaluating true until usage crosses
 * the new line, at which point it is a fresh signal with no memory of the
 * snooze that preceded it.
 */
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
  // Only `critical` is a call to action. `warn` is a value, and it is already
  // reported by `context.level` — routing it here too would put an item in the
  // attention slot that says nothing the meter's colour has not already said.
  if (pressure.level !== 'critical') return [];

  const actions: SignalAction[] = [
    {
      id: 'compact',
      label: 'Compact now',
      primary: true,
      // Parity with the banner: /compact cannot run mid-turn, so the button
      // goes inert rather than queueing a command the CLI will ignore.
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

/**
 * Add the snooze headroom without changing what the user configured.
 *
 * Converted to an absolute `tokens` budget even when the stored setting is a
 * percentage: "+20k" is a token quantity, and expressing it as a percentage of
 * the window would mean a snooze bought four times as much headroom on a 1M
 * session as on a 200k one.
 */
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

/**
 * Skipped MCP servers, routed to the MCP button rather than a banner.
 *
 * One signal per server, not one per set. The old banner keyed on the joined
 * name list so that fixing one broken entry re-reported whatever was still
 * wrong; per-server ids get that for free and additionally let a badge count
 * mean "two servers are broken" instead of "one notice exists".
 */
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
    // The CLI's own message names the offending field and the type it expected.
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
      // Empty, not absent, when a restart would change nothing: the session is
      // already fine and only the recorded expectation was wrong.
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
