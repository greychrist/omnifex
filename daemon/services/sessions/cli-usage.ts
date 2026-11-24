// `--resume` restores an earlier process's totals, so each process takes a baseline before it spends.
// Auxiliary: nothing here may fail or delay a session; every path swallows and logs.

import { randomUUID } from 'node:crypto';
import type { CliModelUsage, CliUsageEvent } from '../cost/cli-process-usage';
import type { SessionHandle } from './types';

export type CliUsageSink = (event: CliUsageEvent) => void;

type Clock = () => Date;
const systemClock: Clock = () => new Date();

function toModelUsage(raw: unknown): CliModelUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: CliModelUsage = {};
  for (const [model, v] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
    const n = (k: string): number => {
      const value = v?.[k];
      return typeof value === 'number' ? value : 0;
    };
    const oneHour = v?.cacheCreationEphemeral1hInputTokens;
    out[model] = {
      inputTokens: n('inputTokens'),
      outputTokens: n('outputTokens'),
      cacheReadInputTokens: n('cacheReadInputTokens'),
      cacheCreationInputTokens: n('cacheCreationInputTokens'),
      ...(typeof oneHour === 'number' && { cacheCreationEphemeral1hInputTokens: oneHour }),
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

export function beginCliProcess(handle: SessionHandle, sink: CliUsageSink, clock: Clock = systemClock): void {
  if (handle.agent !== 'claude') return;
  handle.cliProcess = { id: randomUUID(), startedAt: clock().toISOString() };
  readViaGetUsage(handle, sink, 'baseline', clock);
}

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

export function refreshCliUsage(handle: SessionHandle, sink: CliUsageSink, clock: Clock = systemClock): void {
  if (handle.agent !== 'claude' || !handle.cliProcess) return;
  readViaGetUsage(handle, sink, 'latest', clock);
}
