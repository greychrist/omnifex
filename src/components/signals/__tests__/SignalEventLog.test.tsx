// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SignalEventLog } from '../SignalEventLog';
import type { SessionSignal } from '@/lib/signals/types';

function event(i: number): SessionSignal {
  return {
    id: `e-${i}`,
    tabId: 'tab-1',
    anchor: 'session',
    kind: 'event',
    priority: 'normal',
    key: `context.delta.${i}`,
    title: `Event ${i}`,
    at: Date.UTC(2026, 8, 14, 12, 0, i),
    read: true,
    meta: { delta: 1000 * i, before: 1000 * i, after: 1000 * (i + 1) },
  } as SessionSignal;
}

describe('SignalEventLog', () => {
  it('says so when there is nothing to show', () => {
    render(<SignalEventLog events={[]} />);
    expect(screen.getByText('Nothing to report yet.')).toBeTruthy();
  });

  it('renders every event it is given', () => {
    const { container } = render(<SignalEventLog events={[event(0), event(1), event(2)]} />);
    expect(container.querySelectorAll('li')).toHaveLength(3);
  });

  it('scrolls instead of growing without bound', () => {
    // The store hands the popover up to POPOVER_EVENT_LIMIT events, and a
    // long-running session reaches that limit routinely. Without a bounded
    // container the list simply grew, pushing the model/effort/permission
    // controls and the session id below the fold.
    const { container } = render(<SignalEventLog events={[event(0), event(1)]} />);
    const list = container.querySelector('ul');
    expect(list).toBeTruthy();
    expect(list!.className).toMatch(/overflow-y-auto/);
    expect(list!.className).toMatch(/max-h-/);
  });

  it('keeps the bounded container even when nearly empty, so height does not jump', () => {
    const { container } = render(<SignalEventLog events={[event(0)]} />);
    expect(container.querySelector('ul')!.className).toMatch(/overflow-y-auto/);
  });

  it('honours a caller-supplied className alongside its own', () => {
    const { container } = render(<SignalEventLog events={[event(0)]} className="mt-4" />);
    const cls = container.querySelector('ul')!.className;
    expect(cls).toMatch(/mt-4/);
    expect(cls).toMatch(/overflow-y-auto/);
  });
});
