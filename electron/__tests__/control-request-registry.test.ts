import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createControlRequestRegistry } from '../services/agents/control-request-registry';

describe('createControlRequestRegistry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resolves a pending request when settled, and clears its timeout', async () => {
    const reg = createControlRequestRegistry({ timeoutMs: 1000 });
    const p = reg.create<{ ok: boolean }>('a');
    expect(reg.size()).toBe(1);
    reg.settle('a', { ok: true });
    await expect(p).resolves.toEqual({ ok: true });
    expect(reg.size()).toBe(0);
    // Advancing past the timeout must NOT re-reject a settled request.
    vi.advanceTimersByTime(5000);
  });

  it('rejects a single pending request via fail()', async () => {
    const reg = createControlRequestRegistry({ timeoutMs: 1000 });
    const p = reg.create('a');
    reg.fail('a', new Error('boom'));
    await expect(p).rejects.toThrow('boom');
    expect(reg.size()).toBe(0);
  });

  it('rejects with a timeout error when no response arrives', async () => {
    const reg = createControlRequestRegistry({ timeoutMs: 1000 });
    const p = reg.create('slow', 'get_context_usage');
    const assertion = expect(p).rejects.toThrow(/timed out after 1000ms/);
    vi.advanceTimersByTime(1001);
    await assertion;
    expect(reg.size()).toBe(0);
  });

  it('names the subtype in the timeout error for diagnosability', async () => {
    const reg = createControlRequestRegistry({ timeoutMs: 500 });
    const p = reg.create('x', 'get_context_usage');
    const assertion = expect(p).rejects.toThrow(/get_context_usage/);
    vi.advanceTimersByTime(501);
    await assertion;
  });

  it('failAll rejects every in-flight request (e.g. on engine exit)', async () => {
    const reg = createControlRequestRegistry({ timeoutMs: 1000 });
    const p1 = reg.create('a');
    const p2 = reg.create('b');
    reg.failAll(new Error('engine exited'));
    await expect(p1).rejects.toThrow('engine exited');
    await expect(p2).rejects.toThrow('engine exited');
    expect(reg.size()).toBe(0);
  });

  it('settle/fail on an unknown id is a no-op', () => {
    const reg = createControlRequestRegistry({ timeoutMs: 1000 });
    expect(() => reg.settle('nope', 1)).not.toThrow();
    expect(() => reg.fail('nope', new Error('x'))).not.toThrow();
    expect(reg.size()).toBe(0);
  });
});
