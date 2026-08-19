import { describe, it, expect, vi } from 'vitest';
import { createRenderProfiler } from '@/lib/renderProfiler';
import { installRenderProfilerConsole, type ProfilerConsoleHandle } from '@/lib/renderProfilerConsole';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

function setup() {
  const scheduled: Array<() => void> = [];
  const profiler = createRenderProfiler({
    storage: fakeStorage(),
    now: () => 0,
    schedule: (cb) => { scheduled.push(cb); },
  });
  const target: Record<string, unknown> = {};
  const log = vi.fn();
  installRenderProfilerConsole(target, profiler, { log });
  const handle = target.__omnifexProfile as ProfilerConsoleHandle;
  return { profiler, handle, scheduled, log, target };
}

describe('installRenderProfilerConsole', () => {
  it('exposes the handle under a single global', () => {
    const { target } = setup();
    expect(target.__omnifexProfile).toBeDefined();
  });

  it('turns profiling on and off through the handle', () => {
    const { profiler, handle } = setup();
    expect(profiler.isEnabled()).toBe(false);
    handle.on();
    expect(profiler.isEnabled()).toBe(true);
    handle.off();
    expect(profiler.isEnabled()).toBe(false);
  });

  it('reports status without changing it', () => {
    const { handle, profiler } = setup();
    expect(handle.status()).toEqual({ enabled: false, last: null });
    handle.on();
    expect(handle.status().enabled).toBe(true);
    expect(profiler.isEnabled()).toBe(true);
  });

  it('logs each report as it lands and keeps the latest for `status()`', () => {
    const { handle, profiler, scheduled, log } = setup();
    handle.on();

    profiler.profile('tab-switch');
    profiler.recordRender('AgentSession');
    profiler.recordRender('TranscriptRow');
    profiler.recordRender('TranscriptRow');
    scheduled.forEach(cb => cb());

    expect(log).toHaveBeenCalledTimes(1);
    expect(handle.status().last).toMatchObject({
      interaction: 'tab-switch',
      totalRenders: 3,
    });
  });

  it('keeps only the most recent report', () => {
    const { handle, profiler, scheduled } = setup();
    handle.on();

    profiler.profile('tab-switch');
    profiler.recordRender('A');
    scheduled.shift()!();

    profiler.profile('tab-reorder');
    profiler.recordRender('B');
    profiler.recordRender('B');
    scheduled.shift()!();

    expect(handle.status().last).toMatchObject({
      interaction: 'tab-reorder',
      totalRenders: 2,
    });
  });

  it('is idempotent — installing twice does not double-log a report', () => {
    const scheduled: Array<() => void> = [];
    const profiler = createRenderProfiler({
      storage: fakeStorage(),
      schedule: (cb) => { scheduled.push(cb); },
    });
    const target: Record<string, unknown> = {};
    const log = vi.fn();
    installRenderProfilerConsole(target, profiler, { log });
    installRenderProfilerConsole(target, profiler, { log });

    profiler.setEnabled(true);
    profiler.profile('tab-switch');
    profiler.recordRender('A');
    scheduled.forEach(cb => cb());

    expect(log).toHaveBeenCalledTimes(1);
  });
});
