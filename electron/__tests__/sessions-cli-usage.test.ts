// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { beginCliProcess, recordResultUsage, refreshCliUsage } from '../services/sessions/cli-usage';
import type { SessionHandle } from '../services/sessions/types';
import type { AgentEngine } from '../services/agents/types';
import type { CliUsageEvent } from '../services/cost/cli-process-usage';

const flush = () => new Promise((r) => setTimeout(r, 0));
const now = () => new Date('2026-09-25T10:00:00.000Z');
const OPUS = { inputTokens: 2116, outputTokens: 5299, cacheReadInputTokens: 425072, cacheCreationInputTokens: 70849, costUSD: 0.76 };

function handle(control: (subtype: string, params: unknown) => unknown, agent = 'claude'): SessionHandle {
  const engine = {
    kind: agent,
    sendControlRequest: vi.fn(async (subtype: string, params: unknown) => control(subtype, params)),
  } as unknown as AgentEngine;
  return { agent, engine, sessionId: 'sess-1' } as unknown as SessionHandle;
}

describe('CLI usage capture', () => {
  it('opens a process and records a baseline from get_usage before anything is spent', async () => {
    const events: CliUsageEvent[] = [];
    const h = handle(() => ({ session: { model_usage: {} } }));
    beginCliProcess(h, (e) => { events.push(e); }, now);
    await flush();
    expect(vi.mocked(h.engine.sendControlRequest)).toHaveBeenCalledWith('get_usage', { skip_behaviors: true });
    expect(h.cliProcess).toEqual({ id: expect.any(String), startedAt: '2026-09-25T10:00:00.000Z' });
    expect(events).toEqual([{
      sessionId: 'sess-1', processId: h.cliProcess?.id, startedAt: '2026-09-25T10:00:00.000Z',
      phase: 'baseline', at: '2026-09-25T10:00:00.000Z', modelUsage: {},
    }]);
  });

  it('a restart is a new process with a new baseline', () => {
    const h = handle(() => ({ session: { model_usage: {} } }));
    beginCliProcess(h, () => {}, now);
    const first = h.cliProcess?.id;
    beginCliProcess(h, () => {}, now);
    expect(h.cliProcess?.id).not.toBe(first);
  });

  it('records the running totals every result carries', () => {
    const events: CliUsageEvent[] = [];
    const h = handle(() => ({}));
    h.cliProcess = { id: 'p1', startedAt: 't0' };
    recordResultUsage(h, { type: 'result', modelUsage: { 'claude-opus-5-5[1m]': OPUS } }, (e) => { events.push(e); }, now);
    expect(events).toEqual([expect.objectContaining({
      phase: 'latest', processId: 'p1', startedAt: 't0',
      modelUsage: { 'claude-opus-5-5[1m]': { inputTokens: 2116, outputTokens: 5299, cacheReadInputTokens: 425072, cacheCreationInputTokens: 70849 } },
    })]);
  });

  it('ignores a result with no totals, and a handle with no open process', () => {
    const sink = vi.fn();
    const h = handle(() => ({}));
    recordResultUsage(h, { type: 'result', modelUsage: { m: OPUS } }, sink, now);
    h.cliProcess = { id: 'p1', startedAt: 't0' };
    recordResultUsage(h, { type: 'result' }, sink, now);
    expect(sink).not.toHaveBeenCalled();
  });

  it('refreshes the latest figure on demand — a side question after the last turn', async () => {
    const events: CliUsageEvent[] = [];
    const h = handle(() => ({ session: { model_usage: { 'claude-opus-5-5[1m]': OPUS } } }));
    h.cliProcess = { id: 'p1', startedAt: 't0' };
    refreshCliUsage(h, (e) => { events.push(e); }, now);
    await flush();
    expect(events).toEqual([expect.objectContaining({ phase: 'latest', processId: 'p1' })]);
  });

  it('never throws: a CLI error, a malformed reply and a failing sink are all swallowed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = handle(() => { throw new Error('get_usage is not supported in this context'); });
    expect(() => { beginCliProcess(broken, () => {}, now); }).not.toThrow();
    const malformed = handle(() => ({ nope: true }));
    const sink = vi.fn();
    beginCliProcess(malformed, sink, now);
    const throwingSink = handle(() => ({ session: { model_usage: {} } }));
    beginCliProcess(throwingSink, () => { throw new Error('db locked'); }, now);
    await flush();
    expect(sink).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does nothing for Codex, which has no CLI totals', () => {
    const h = handle(() => ({ session: { model_usage: {} } }), 'codex');
    beginCliProcess(h, vi.fn(), now);
    expect(h.engine.sendControlRequest).not.toHaveBeenCalled();
    expect(h.cliProcess).toBeUndefined();
  });
});
