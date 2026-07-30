// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ContextTimelineTick } from '../ContextTimelineTick';
import type { ContextTimelinePoint } from '@/lib/contextTimeline';

afterEach(() => {
  cleanup();
});

const point = (over: Partial<ContextTimelinePoint> = {}): ContextTimelinePoint => ({
  tokens: 120_000,
  delta: 20_000,
  isSample: true,
  isJump: false,
  isReset: false,
  fraction: 0.12,
  ...over,
});

describe('ContextTimelineTick', () => {
  it('shows the context size at a sample', () => {
    render(<ContextTimelineTick point={point()} />);
    expect(screen.getByText('120k')).toBeInTheDocument();
  });

  it('renders a rail but no readout on a carried-forward row', () => {
    const { container } = render(
      <ContextTimelineTick point={point({ isSample: false, delta: null })} />,
    );
    expect(screen.queryByText('120k')).toBeNull();
    // The rail line itself still renders so the timeline reads as continuous.
    expect(container.querySelector('[data-timeline-rail]')).toBeInTheDocument();
  });

  it('renders nothing at all before the first sample', () => {
    const { container } = render(<ContextTimelineTick point={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('labels a jump with its delta', () => {
    render(<ContextTimelineTick point={point({ isJump: true, delta: 325_000 })} />);
    expect(screen.getByText(/\+325k/)).toBeInTheDocument();
  });

  it('does not label an ordinary step with its delta', () => {
    render(<ContextTimelineTick point={point()} />);
    expect(screen.queryByText(/\+20k/)).toBeNull();
  });

  it('marks a post-compaction reset', () => {
    render(<ContextTimelineTick point={point({ isReset: true, delta: null })} />);
    expect(screen.getByText(/compacted/i)).toBeInTheDocument();
  });

  it('scales the bar with the window fraction', () => {
    const { container } = render(<ContextTimelineTick point={point({ fraction: 0.42 })} />);
    const bar = container.querySelector('[data-timeline-bar]') as HTMLElement;
    expect(bar).toHaveStyle({ width: '42%' });
  });

  it('exposes the step detail as a tooltip', () => {
    render(<ContextTimelineTick point={point({ isJump: true, delta: 325_000 })} />);
    expect(screen.getByTitle(/325k/)).toBeInTheDocument();
  });
});
