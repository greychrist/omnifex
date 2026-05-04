import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createTabStatusService,
  type TabStatusSummary,
} from '../services/tab-status';

function summary(
  tabId: string,
  busy: boolean,
  overrides: Partial<TabStatusSummary> = {},
): TabStatusSummary {
  return {
    tabId,
    title: tabId,
    busy,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('TabStatusService', () => {
  let broadcast: ReturnType<typeof vi.fn<(summaries: TabStatusSummary[]) => void>>;

  beforeEach(() => {
    broadcast = vi.fn<(summaries: TabStatusSummary[]) => void>();
  });

  it('starts empty', () => {
    const svc = createTabStatusService({ broadcast });
    expect(svc.list()).toEqual([]);
    expect(svc.busyTabIds()).toEqual([]);
  });

  it('publish stores the summary and broadcasts the new list', () => {
    const svc = createTabStatusService({ broadcast });
    const s = summary('tab-1', false);
    svc.publish(s);
    expect(svc.list()).toEqual([s]);
    expect(broadcast).toHaveBeenCalledWith([s]);
  });

  it('publish updates an existing tab in place', () => {
    const svc = createTabStatusService({ broadcast });
    svc.publish(summary('tab-1', false, { title: 'old' }));
    svc.publish(summary('tab-1', true, { title: 'new' }));
    const list = svc.list();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('new');
    expect(list[0].busy).toBe(true);
  });

  it('publish does not broadcast when the summary is byte-identical (no-op write)', () => {
    const svc = createTabStatusService({ broadcast });
    const fixedTime = 1_700_000_000_000;
    const s = summary('tab-1', false, { updatedAt: fixedTime });
    svc.publish(s);
    broadcast.mockClear();
    // Same payload — service should detect equality and skip the broadcast.
    svc.publish({ ...s });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('remove drops the tab and broadcasts the trimmed list', () => {
    const svc = createTabStatusService({ broadcast });
    svc.publish(summary('tab-1', false));
    svc.publish(summary('tab-2', true));
    broadcast.mockClear();
    svc.remove('tab-1');
    expect(svc.list().map((s) => s.tabId)).toEqual(['tab-2']);
    expect(broadcast).toHaveBeenCalledWith([expect.objectContaining({ tabId: 'tab-2' })]);
  });

  it('remove is a no-op for an unknown tab and does not broadcast', () => {
    const svc = createTabStatusService({ broadcast });
    svc.publish(summary('tab-1', false));
    broadcast.mockClear();
    svc.remove('tab-unknown');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('busyTabIds returns only tabs whose busy flag is true', () => {
    const svc = createTabStatusService({ broadcast });
    svc.publish(summary('idle-1', false));
    svc.publish(summary('busy-1', true));
    svc.publish(summary('idle-2', false));
    svc.publish(summary('busy-2', true));
    expect(svc.busyTabIds().sort()).toEqual(['busy-1', 'busy-2']);
  });

  it('list preserves insertion order (matches tab-bar order from the renderer)', () => {
    const svc = createTabStatusService({ broadcast });
    svc.publish(summary('first', false));
    svc.publish(summary('second', true));
    svc.publish(summary('third', false));
    expect(svc.list().map((s) => s.tabId)).toEqual(['first', 'second', 'third']);
  });

  it('updating an existing tab keeps its insertion order (does not move it to the end)', () => {
    const svc = createTabStatusService({ broadcast });
    svc.publish(summary('a', false));
    svc.publish(summary('b', false));
    svc.publish(summary('c', false));
    svc.publish(summary('a', true)); // mutate in place
    expect(svc.list().map((s) => s.tabId)).toEqual(['a', 'b', 'c']);
  });

  it('clearAll empties the map and broadcasts an empty list', () => {
    const svc = createTabStatusService({ broadcast });
    svc.publish(summary('tab-1', false));
    svc.publish(summary('tab-2', true));
    broadcast.mockClear();
    svc.clearAll();
    expect(svc.list()).toEqual([]);
    expect(broadcast).toHaveBeenCalledWith([]);
  });

  it('clearAll is a no-op when already empty', () => {
    const svc = createTabStatusService({ broadcast });
    svc.clearAll();
    expect(broadcast).not.toHaveBeenCalled();
  });
});
