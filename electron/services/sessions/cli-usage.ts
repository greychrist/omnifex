// Sessions module — capturing the CLI's own running token totals
//
// The Cost Report prices transcripts, and the CLI keeps some model calls out
// of the transcript (side questions, title generation). It counts them in its
// running per-model totals, which it reports on every `result` (`modelUsage`)
// and from `get_usage` (`session.model_usage`). This module reads those
// figures and hands them to the sink main and the daemon both wire to
// `createCliProcessUsageStore(db).record`; cost/unlogged-spend.ts prices the
// difference. See docs/superpowers/specs/2026-09-25-side-chat-design.md, "Cost".
//
// Each CLI process takes a BASELINE before it spends anything: `--resume`
// restores an earlier process's saved totals when it can, so a process's
// figures do not reliably start at zero.
//
// Auxiliary, like the Brain: nothing here may fail or delay a session. Every
// path swallows and logs.

import { randomUUID } from 'node:crypto';
import type { CliModelUsage, CliUsageEvent } from '../cost/cli-process-usage';
import type { SessionHandle } from './types';

export type CliUsageSink = (event: CliUsageEvent) => void;

type Clock = () => Date;
const systemClock: Clock = () => new Date();

/** Keep the four token counts; the CLI's entries also carry costUSD, context sizes and more. */
function toModelUsage(raw: unknown): CliModelUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: CliModelUsage = {};
  for (const [model, v] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
    const n = (k: string): number => {
      const value = v?.[k];
      return typeof value === 'number' ? value : 0;
    };
    out[model] = {
      inputTokens: n('inputTokens'),
      outputTokens: n('outputTokens'),
      cacheReadInputTokens: n('cacheReadInputTokens'),
      cacheCreationInputTokens: n('cacheCreationInputTokens'),
    };
  }
  return out;
}

function emit(handle: SessionHandle, sink: CliUsageSink, phase: CliUsageEvent['phase'], modelUsage: CliModelUsage, clock: Clock): void {
  const proc = handle.cliProcess;
  if (!proc || !handle.sessionId) return;
  try {
    sink({ sessionId: handle.sessionId, processId: proc.id, startedAt: proc.startedAt, phase, at: clock().toISOString(), modelUsage });
  } catch (err) {
    console.warn('[cli-usage] recording failed:', err);
  }
}

function readViaGetUsage(handle: SessionHandle, sink: CliUsageSink, phase: CliUsageEvent['phase'], clock: Clock): void {
  const proc = handle.cliProcess;
  handle.engine
    .sendControlRequest<{ session?: { model_usage?: unknown } }>('get_usage', { skip_behaviors: true })
    .then((res) => {
      // A restart since the request went out: this figure is the old process's.
      if (handle.cliProcess !== proc) return;
      const usage = toModelUsage(res?.session?.model_usage);
      if (!usage) {
        console.warn('[cli-usage] get_usage reply had no session.model_usage; not recorded');
        return;
      }
      emit(handle, sink, phase, usage, clock);
    })
    .catch((err: unknown) => {
      console.warn(`[cli-usage] get_usage (${phase}) failed; not recorded:`, err);
    });
}

/**
 * A CLI process has just started (first start, resume or restart): give it
 * an id and read its baseline. Call once per `engine.start()`.
 */
export function beginCliProcess(handle: SessionHandle, sink: CliUsageSink, clock: Clock = systemClock): void {
  if (handle.agent !== 'claude') return;
  handle.cliProcess = { id: randomUUID(), startedAt: clock().toISOString() };
  readViaGetUsage(handle, sink, 'baseline', clock);
}

/** Every `result` carries the process's running totals. */
export function recordResultUsage(
  handle: SessionHandle,
  message: Record<string, unknown>,
  sink: CliUsageSink,
  clock: Clock = systemClock,
): void {
  if (message.type !== 'result') return;
  const usage = toModelUsage(message.modelUsage);
  if (!usage) return;
  emit(handle, sink, 'latest', usage, clock);
}

/**
 * Read the latest totals now. For spend that no `result` follows — a side
 * question asked after the last turn.
 */
export function refreshCliUsage(handle: SessionHandle, sink: CliUsageSink, clock: Clock = systemClock): void {
  if (handle.agent !== 'claude' || !handle.cliProcess) return;
  readViaGetUsage(handle, sink, 'latest', clock);
}
