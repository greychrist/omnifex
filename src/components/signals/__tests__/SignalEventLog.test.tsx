// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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

afterEach(() => { cleanup(); });

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

  it('makes an event with a transcript message a button that jumps to it', () => {
    const onSelect = vi.fn();
    render(<SignalEventLog events={[{ ...event(1), messageUuid: 'p-1' }]} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /jump to/i }));
    expect(onSelect).toHaveBeenCalledWith('p-1');
  });

  it('leaves an event with no transcript message as plain text', () => {
    render(<SignalEventLog events={[event(1)]} onSelect={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('draws no buttons when nothing handles a jump', () => {
    render(<SignalEventLog events={[{ ...event(1), messageUuid: 'p-1' }]} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
