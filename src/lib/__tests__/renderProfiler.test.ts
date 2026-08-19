import { describe, it, expect, vi } from 'vitest';
import { createRenderProfiler, PROFILE_STORAGE_KEY } from '@/lib/renderProfiler';

/** Minimal Storage stand-in so these tests run under the `node` environment. */
function fakeStorage(initial?: Record<string, string>) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    _map: map,
  };
}

/** A clock the test drives by hand. */
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('renderProfiler', () => {
  describe('enablement', () => {
    it('is off by default so the profiler costs nothing in a normal session', () => {
      const p = createRenderProfiler({ storage: fakeStorage() });
      expect(p.isEnabled()).toBe(false);
    });

    it('reads the persisted flag at construction, so a packaged build can be profiled without a rebuild', () => {
      const p = createRenderProfiler({
        storage: fakeStorage({ [PROFILE_STORAGE_KEY]: '1' }),
      });
      expect(p.isEnabled()).toBe(true);
    });

    it('persists the flag so it survives the reload that follows enabling it', () => {
      const storage = fakeStorage();
      const p = createRenderProfiler({ storage });
      p.setEnabled(true);
      expect(storage.getItem(PROFILE_STORAGE_KEY)).toBe('1');
      p.setEnabled(false);
      expect(storage.getItem(PROFILE_STORAGE_KEY)).toBe(null);
    });

    it('survives a storage that throws (packaged renderer with storage disabled)', () => {
      const throwing = {
        getItem: () => { throw new Error('nope'); },
        setItem: () => { throw new Error('nope'); },
        removeItem: () => { throw new Error('nope'); },
      };
      const p = createRenderProfiler({ storage: throwing });
      expect(p.isEnabled()).toBe(false);
      expect(() => { p.setEnabled(true); }).not.toThrow();
      // In-memory state still flips even though the write failed.
      expect(p.isEnabled()).toBe(true);
    });

    it('tolerates a null storage (non-browser context)', () => {
      const p = createRenderProfiler({ storage: null });
      expect(p.isEnabled()).toBe(false);
      expect(() => { p.setEnabled(true); }).not.toThrow();
    });
  });

  describe('when disabled', () => {
    it('records nothing and opens no interaction', () => {
      const p = createRenderProfiler({ storage: fakeStorage() });
      p.begin('tab-switch');
      p.recordRender('AgentSession');
      expect(p.snapshot()).toBeNull();
      expect(p.end()).toBeNull();
    });
  });

  describe('counting renders', () => {
    it('tallies renders per component name', () => {
      const p = createRenderProfiler({ storage: fakeStorage() });
      p.setEnabled(true);
      p.begin('tab-switch');
      p.recordRender('AgentSession');
      p.recordRender('AgentSession');
      p.recordRender('TabPanel');
      const report = p.end();
      expect(report).not.toBeNull();
      expect(report!.renders).toEqual([
        { name: 'AgentSession', count: 2 },
        { name: 'TabPanel', count: 1 },
      ]);
      expect(report!.totalRenders).toBe(3);
    });

    it('sorts by count descending, then name, so the worst offender reads first', () => {
      const p = createRenderProfiler({ storage: fakeStorage() });
      p.setEnabled(true);
      p.begin('x');
      p.recordRender('Zebra');
      p.recordRender('Apple');
      p.recordRender('Apple');
      p.recordRender('Mango');
      const report = p.end()!;
      expect(report.renders.map(r => r.name)).toEqual(['Apple', 'Mango', 'Zebra']);
    });

    it('adds a bulk count in one call, for unvirtualised lists', () => {
      const p = createRenderProfiler({ storage: fakeStorage() });
      p.setEnabled(true);
      p.begin('tab-switch');
      p.recordRenders('TranscriptRow', 240);
      p.recordRenders('TranscriptRow', 60);
      const report = p.end()!;
      expect(report.renders).toEqual([{ name: 'TranscriptRow', count: 300 }]);
      expect(report.totalRenders).toBe(300);
    });

    it('ignores a bulk count of zero or less rather than creating an empty row', () => {
      const p = createRenderProfiler({ storage: fakeStorage() });
      p.setEnabled(true);
      p.begin('tab-switch');
      p.recordRenders('TranscriptRow', 0);
      p.recordRenders('TranscriptRow', -5);
      expect(p.end()!.renders).toEqual([]);
    });

    it('ignores a bulk count while disabled', () => {
      const p = createRenderProfiler({ storage: fakeStorage() });
      p.begin('tab-switch');
      p.recordRenders('TranscriptRow', 100);
      expect(p.snapshot()).toBeNull();
    });

    it('ignores renders that happen outside an interaction', () => {
      const p = createRenderProfiler({ storage: fakeStorage() });
      p.setEnabled(true);
      p.recordRender('AgentSession'); // no begin() yet — background churn
      p.begin('tab-switch');
      p.recordRender('TabPanel');
      const report = p.end()!;
      expect(report.renders).toEqual([{ name: 'TabPanel', count: 1 }]);
    });

    it('clears the previous tally when a new interaction begins', () => {
      const p = createRenderProfiler({ storage: fakeStorage() });
      p.setEnabled(true);
      p.begin('first');
      p.recordRender('TabPanel');
      p.begin('second');
      p.recordRender('AgentSession');
      const report = p.end()!;
      expect(report.interaction).toBe('second');
      expect(report.renders).toEqual([{ name: 'AgentSession', count: 1 }]);
    });
  });

  describe('timing', () => {
    it('measures the interaction against the injected clock', () => {
      const clock = fakeClock(1000);
      const p = createRenderProfiler({ storage: fakeStorage(), now: clock.now });
      p.setEnabled(true);
      p.begin('tab-reorder');
      clock.advance(42);
      const report = p.end()!;
      expect(report.interaction).toBe('tab-reorder');
      expect(report.durationMs).toBe(42);
    });

    it('returns null from end() when no interaction is open', () => {
      const p = createRenderProfiler({ storage: fakeStorage() });
      p.setEnabled(true);
      expect(p.end()).toBeNull();
    });

    it('closes the interaction, so a second end() reports nothing', () => {
      const p = createRenderProfiler({ storage: fakeStorage() });
      p.setEnabled(true);
      p.begin('tab-switch');
      expect(p.end()).not.toBeNull();
      expect(p.end()).toBeNull();
    });

    it('snapshot() peeks without closing the interaction', () => {
      const clock = fakeClock();
      const p = createRenderProfiler({ storage: fakeStorage(), now: clock.now });
      p.setEnabled(true);
      p.begin('tab-switch');
      p.recordRender('TabPanel');
      clock.advance(5);
      expect(p.snapshot()!.totalRenders).toBe(1);
      p.recordRender('TabPanel');
      expect(p.end()!.totalRenders).toBe(2);
    });
  });

  describe('profile() — begin plus a scheduled close', () => {
    it('closes the interaction on the injected scheduler and emits the report', () => {
      const scheduled: Array<() => void> = [];
      const clock = fakeClock();
      const p = createRenderProfiler({
        storage: fakeStorage(),
        now: clock.now,
        schedule: (cb) => { scheduled.push(cb); },
      });
      p.setEnabled(true);
      const seen: unknown[] = [];
      p.onReport((r) => seen.push(r));

      p.profile('tab-switch');
      p.recordRender('AgentSession');
      p.recordRender('TabPanel');
      clock.advance(120);
      expect(seen).toHaveLength(0); // still open — nothing emitted yet

      scheduled.forEach(cb => cb());

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        interaction: 'tab-switch',
        durationMs: 120,
        totalRenders: 2,
      });
    });

    it('does not schedule anything while disabled', () => {
      const schedule = vi.fn();
      const p = createRenderProfiler({ storage: fakeStorage(), schedule });
      p.profile('tab-switch');
      expect(schedule).not.toHaveBeenCalled();
    });

    it('unsubscribes a report listener', () => {
      const scheduled: Array<() => void> = [];
      const p = createRenderProfiler({
        storage: fakeStorage(),
        schedule: (cb) => { scheduled.push(cb); },
      });
      p.setEnabled(true);
      const seen: unknown[] = [];
      const off = p.onReport((r) => seen.push(r));
      off();
      p.profile('tab-switch');
      scheduled.forEach(cb => cb());
      expect(seen).toHaveLength(0);
    });

    it('keeps emitting to other listeners when one throws', () => {
      const scheduled: Array<() => void> = [];
      const p = createRenderProfiler({
        storage: fakeStorage(),
        schedule: (cb) => { scheduled.push(cb); },
      });
      p.setEnabled(true);
      const seen: unknown[] = [];
      p.onReport(() => { throw new Error('listener blew up'); });
      p.onReport((r) => seen.push(r));
      p.profile('tab-switch');
      expect(() => scheduled.forEach(cb => cb())).not.toThrow();
      expect(seen).toHaveLength(1);
    });
  });
});
