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
  level: 'none',
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

  // The cell still occupies its width before the series starts. Collapsing it
  // to nothing left the opening rows un-indented while every later row was
  // pushed right by the gutter — a visible jog partway down the transcript.
  it('reserves the gutter but draws nothing before the first sample', () => {
    const { container } = render(<ContextTimelineTick point={undefined} />);
    expect(container).not.toBeEmptyDOMElement();
    expect(container.querySelector('[data-timeline-rail]')).toBeNull();
    expect(container.querySelector('[data-timeline-readout]')).toBeNull();
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

// jsdom does no layout, so these assert the structural property that caused
// the overlap rather than measuring it: an absolutely-positioned readout
// contributes no height, so on a short row it printed straight over the next
// tick's. The compact marker was the worst case — the shortest row in the
// transcript, carrying the most label lines.
describe('ContextTimelineTick — readout cannot overrun the next row', () => {
  const readout = (container: HTMLElement) =>
    container.querySelector('[data-timeline-readout]') as HTMLElement | null;

  it('keeps the readout in normal flow so the row grows to fit it', () => {
    const { container } = render(<ContextTimelineTick point={point()} />);
    const el = readout(container);
    expect(el).toBeInTheDocument();
    expect(el?.className).not.toMatch(/\babsolute\b/);
  });

  it('keeps the readout in flow on a compacted row, which stacks the most labels', () => {
    const { container } = render(
      <ContextTimelineTick point={point({ isReset: true, delta: null })} />,
    );
    expect(readout(container)?.className).not.toMatch(/\babsolute\b/);
  });

  // The rail is the one part that must stay absolute: it spans the full row
  // height so the series reads as one continuous line.
  it('leaves the rail absolutely positioned', () => {
    const { container } = render(<ContextTimelineTick point={point()} />);
    const rail = container.querySelector('[data-timeline-rail]') as HTMLElement;
    expect(rail.className).toMatch(/\babsolute\b/);
  });

  it('reserves room for the readout so a short row cannot collapse under it', () => {
    const { container } = render(<ContextTimelineTick point={point()} />);
    expect((container.firstChild as HTMLElement).className).toMatch(/\bmin-h-/);
  });
});

// The rail's colour is the at-a-glance signal: scrolling a long session, the
// eye should find where it went red without reading a single number.
describe('ContextTimelineTick — rail colour tracks pressure', () => {
  const rail = (container: HTMLElement) =>
    (container.querySelector('[data-timeline-rail]') as HTMLElement).className;

  it('is green under the budget', () => {
    const { container } = render(<ContextTimelineTick point={point({ level: 'none' })} />);
    expect(rail(container)).toMatch(/emerald/);
  });

  it('is amber approaching the budget', () => {
    const { container } = render(<ContextTimelineTick point={point({ level: 'warn' })} />);
    expect(rail(container)).toMatch(/amber/);
  });

  it('is red at or past the budget', () => {
    const { container } = render(<ContextTimelineTick point={point({ level: 'critical' })} />);
    expect(rail(container)).toMatch(/red/);
  });

  // Carried-forward rows draw only the rail, and they hold the previous
  // reading — so they must hold its colour or the line reads as striped.
  it('colours a carried-forward row the same as the sample it carries', () => {
    const { container } = render(
      <ContextTimelineTick point={point({ isSample: false, delta: null, level: 'critical' })} />,
    );
    expect(rail(container)).toMatch(/red/);
  });

  it('keeps the dashed treatment at a compaction reset', () => {
    const { container } = render(
      <ContextTimelineTick point={point({ isReset: true, delta: null, level: 'none' })} />,
    );
    const el = container.querySelector('[data-timeline-rail]') as HTMLElement;
    expect(el).toHaveAttribute('data-timeline-reset');
    // Dashes come from a repeating gradient, not a border: an unlayered
    // `* { border-color }` in styles.css outranks border-colour utilities,
    // so a bordered rail could not carry the level colour.
    expect(el.style.backgroundImage).toMatch(/repeating-linear-gradient/);
    expect(rail(container)).toMatch(/emerald/);
  });

  it('colours a dashed reset rail by its level too', () => {
    const { container } = render(
      <ContextTimelineTick point={point({ isReset: true, delta: null, level: 'critical' })} />,
    );
    expect(rail(container)).toMatch(/red/);
  });

  it('colours the bar to match the rail', () => {
    const { container } = render(<ContextTimelineTick point={point({ level: 'critical' })} />);
    const bar = container.querySelector('[data-timeline-bar]') as HTMLElement;
    expect(bar.className).toMatch(/red/);
  });

  // Level and jump are orthogonal: level is where you are, the delta label is
  // what the last step did. A jump under budget must not fake a red rail.
  it('does not let a jump override the level colour', () => {
    const { container } = render(
      <ContextTimelineTick point={point({ isJump: true, delta: 325_000, level: 'none' })} />,
    );
    expect(rail(container)).toMatch(/emerald/);
    expect(screen.getByText(/\+325k/)).toBeInTheDocument();
  });
});

describe('ContextTimelineTick — the rail reads as one line', () => {
  it('draws a rail thick enough to be a line rather than a hairline', () => {
    const { container } = render(<ContextTimelineTick point={point()} />);
    const rail = container.querySelector('[data-timeline-rail]') as HTMLElement;
    expect(rail.className).toMatch(/\bw-1\b/);
    expect(rail.className).not.toMatch(/\bw-px\b/);
  });

  // Continuity depends on the rail spanning the row edge to edge; the gap
  // between rows is closed in ClaudeTranscript by moving the row spacing
  // inside the row. jsdom does no layout, so the span is what is checkable
  // here — that the rail has no vertical inset of its own.
  it('spans the full height of its row', () => {
    const { container } = render(<ContextTimelineTick point={point()} />);
    const rail = container.querySelector('[data-timeline-rail]') as HTMLElement;
    expect(rail.className).toMatch(/\binset-y-0\b/);
  });
});

// The context size is the number you actually read while scrolling; the delta
// and reset labels are annotations on it. They are sized differently on
// purpose — the gutter is only 4rem wide, and "compacted" at the larger size
// does not fit on one line.
describe('ContextTimelineTick — readout sizing', () => {
  it('sets the context size larger than the annotations', () => {
    render(<ContextTimelineTick point={point({ isJump: true, delta: 325_000 })} />);
    expect(screen.getByText('120k').className).toMatch(/text-xs/);
    expect(screen.getByText(/\+325k/).className).toMatch(/text-\[10px\]/);
  });

  it('keeps the compacted label small enough to fit the gutter', () => {
    render(<ContextTimelineTick point={point({ isReset: true, delta: null })} />);
    expect(screen.getByText(/compacted/i).className).toMatch(/text-\[10px\]/);
  });
});

describe('ContextTimelineTick — readout order', () => {
  // The size reads first, with the proportional bar beneath it. The jump and
  // reset annotations stay under the bar: they qualify the number rather than
  // competing with it.
  const orderOf = (container: HTMLElement) => {
    const readout = container.querySelector('[data-timeline-readout]') as HTMLElement;
    return Array.from(readout.children).map((c) =>
      c.querySelector('[data-timeline-bar]') ? 'bar' : (c.textContent ?? '').trim(),
    );
  };

  it('puts the size above the bar', () => {
    const { container } = render(<ContextTimelineTick point={point()} />);
    expect(orderOf(container)).toEqual(['120k', 'bar']);
  });

  it('keeps the jump delta below the bar', () => {
    const { container } = render(
      <ContextTimelineTick point={point({ isJump: true, delta: 325_000 })} />,
    );
    expect(orderOf(container)).toEqual(['120k', 'bar', '▲ +325k']);
  });

  it('keeps the compacted label below the bar', () => {
    const { container } = render(
      <ContextTimelineTick point={point({ isReset: true, delta: null })} />,
    );
    expect(orderOf(container)).toEqual(['120k', 'bar', 'compacted']);
  });
});
