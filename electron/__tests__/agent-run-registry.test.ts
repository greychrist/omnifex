import { describe, it, expect, vi } from 'vitest';
import { createAgentRunRegistry, type AgentRunHandle } from '../services/agent-run-registry';
import type { Query } from '@anthropic-ai/claude-agent-sdk';

function fakeHandle(): AgentRunHandle {
  const close = vi.fn();
  return { query: { close } as unknown as Query, status: 'running' };
}

describe('AgentRunRegistry', () => {
  it('listActiveRunIds returns runs whose status is "running"', () => {
    const reg = createAgentRunRegistry();
    reg.register(1, fakeHandle());
    reg.register(2, fakeHandle());
    reg.register(3, fakeHandle());
    reg.setStatus(2, 'completed');
    expect(reg.listActiveRunIds().sort()).toEqual([1, 3]);
  });

  it('killAll calls kill() on every registered run regardless of status', () => {
    const reg = createAgentRunRegistry();
    const a = fakeHandle();
    const b = fakeHandle();
    const c = fakeHandle();
    reg.register(1, a);
    reg.register(2, b);
    reg.register(3, c);
    reg.setStatus(2, 'completed');
    reg.killAll();
    expect(a.query.close).toHaveBeenCalled();
    expect(b.query.close).not.toHaveBeenCalled(); // already non-running
    expect(c.query.close).toHaveBeenCalled();
    expect(a.status).toBe('killed');
    expect(c.status).toBe('killed');
  });
});
