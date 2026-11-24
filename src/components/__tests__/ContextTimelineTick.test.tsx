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
  prevTokens: 100_000,
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
    expect(container.querySelector('[data-timeline-rail]')).toBeInTheDocument();
  });

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

  it('labels an ordinary step with its delta', () => {
    render(<ContextTimelineTick point={point()} />);
    expect(screen.getByText('+20k')).toBeInTheDocument();
  });

  it('marks a post-compaction reset', () => {
    render(<ContextTimelineTick point={point({ isReset: true, delta: null })} />);
    expect(screen.getByText(/compacted/i)).toBeInTheDocument();
  });

  it('draws no proportional bar; the share of the window is in the tooltip', () => {
    const { container } = render(<ContextTimelineTick point={point({ fraction: 0.42 })} />);
    expect(container.querySelector('[data-timeline-bar]')).toBeNull();
    expect(screen.getByTitle(/42% of the window/)).toBeInTheDocument();
  });

  it('exposes before → after as a tooltip', () => {
    render(<ContextTimelineTick point={point({ isJump: true, delta: 325_000, prevTokens: 477_000, tokens: 802_000 })} />);
    expect(screen.getByTitle(/477k → 802k/)).toBeInTheDocument();
  });
});

// jsdom does no layout: an absolutely-positioned readout contributes no
// height, so the structure is what can be pinned.
describe('ContextTimelineTick — readout cannot overrun the next row', () => {
  const readout = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-timeline-readout]');

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

  it('leaves the rail absolutely positioned', () => {
    const { container } = render(<ContextTimelineTick point={point()} />);
    const rail = container.querySelector('[data-timeline-rail]') as HTMLElement;
    expect(rail.className).toMatch(/\babsolute\b/);
  });

  // The body column's `pb-4` lets rails meet between rows; on the last row
  // `bottom-4` cancels it.
  it('runs edge to edge on an ordinary row', () => {
    const { container } = render(<ContextTimelineTick point={point()} />);
    const rail = container.querySelector('[data-timeline-rail]') as HTMLElement;
    expect(rail.className).toMatch(/\binset-y-0\b/);
    expect(rail.className).not.toMatch(/\brounded-b/);
  });

  it('stops level with the last card and caps the line off', () => {
    const { container } = render(<ContextTimelineTick point={point()} isLast />);
    const rail = container.querySelector('[data-timeline-rail]') as HTMLElement;
    expect(rail.className).not.toMatch(/\binset-y-0\b/);
    expect(rail.className).toMatch(/\bbottom-4\b/);
    expect(rail.className).toMatch(/\btop-0\b/);
    expect(rail.className).toMatch(/\brounded-b-full\b/);
  });

  it('reserves room for the readout so a short row cannot collapse under it', () => {
    const { container } = render(<ContextTimelineTick point={point()} />);
    expect((container.firstChild as HTMLElement).className).toMatch(/\bmin-h-/);
  });
});

describe('ContextTimelineTick — rail color tracks pressure', () => {
  const rail = (container: HTMLElement) =>
    (container.querySelector('[data-timeline-rail]') as HTMLElement).className;

  it('draws no solid line under the budget', () => {
    const { container } = render(<ContextTimelineTick point={point({ level: 'none' })} />);
    expect(rail(container)).not.toMatch(/\bbg-/);
  });

  it('is amber approaching the budget', () => {
    const { container } = render(<ContextTimelineTick point={point({ level: 'warn' })} />);
    expect(rail(container)).toMatch(/amber/);
  });

  it('is red at or past the budget', () => {
    const { container } = render(<ContextTimelineTick point={point({ level: 'critical' })} />);
    expect(rail(container)).toMatch(/red/);
  });

  it('colors a carried-forward row the same as the sample it carries', () => {
    const { container } = render(
      <ContextTimelineTick point={point({ isSample: false, delta: null, level: 'critical' })} />,
    );
    expect(rail(container)).toMatch(/red/);
  });

  it('draws a reset row with the same solid line as any other', () => {
    const { container } = render(
      <ContextTimelineTick point={point({ isReset: true, delta: null, level: 'critical' })} />,
    );
    const el = container.querySelector('[data-timeline-rail]') as HTMLElement;
    expect(el).not.toHaveAttribute('data-timeline-reset');
    expect(el.style.backgroundImage).toBe('');
    expect(rail(container)).toMatch(/bg-red-600/);
  });

  it.each(['none', 'warn', 'critical'] as const)(
    'paints the %s rail in exactly the badge color',
    (level) => {
      const color = (cls: string, prefix: 'bg' | 'text') =>
        (new RegExp(`\\b${prefix}-([a-z]+-\\d+(?:/\\d+)?)\\b`).exec(cls))?.[1];
      const solid = render(<ContextTimelineTick point={point({ level })} />).container;
      const badgeBg = color(
        (solid.querySelector('[data-timeline-badge]') as HTMLElement).className, 'bg',
      );
      expect(badgeBg).toBeDefined();
      if (level !== 'none') expect(color(rail(solid), 'bg')).toBe(badgeBg);
    },
  );

  it('sets the size in a badge colored to match the rail', () => {
    const { container } = render(<ContextTimelineTick point={point({ level: 'critical' })} />);
    const badge = container.querySelector('[data-timeline-badge]') as HTMLElement;
    expect(badge).toHaveTextContent('120k');
    expect(badge.className).toMatch(/red/);
    expect(badge.className).toMatch(/rounded/);
  });

  // White on emerald-600 is 3.67:1 — under WCAG AA's 4.5:1 for 12px text.
  // emerald-700 is 5.37:1.
  it('sets the under-budget badge at an AA contrast', () => {
    const { container } = render(<ContextTimelineTick point={point({ level: 'none' })} />);
    const badge = container.querySelector('[data-timeline-badge]') as HTMLElement;
    expect(badge.className).toMatch(/\bbg-emerald-700\b/);
    expect(badge.className).toMatch(/\btext-white\b/);
  });

  it('keeps the size badge squarer than a pill', () => {
    const { container } = render(<ContextTimelineTick point={point()} />);
    const badge = container.querySelector('[data-timeline-badge]') as HTMLElement;
    expect(badge.className).toMatch(/\brounded-sm\b/);
    expect(badge.className).not.toMatch(/\brounded-md\b/);
  });

  it('fills the size badge solidly, so the line does not show through it', () => {
    const { container } = render(<ContextTimelineTick point={point()} />);
    const badge = container.querySelector('[data-timeline-badge]') as HTMLElement;
    expect(badge.className).not.toMatch(/bg-[a-z]+-\d+\/\d+/);
  });

  it('draws the line beside the badges, touching their left edge', () => {
    const { container } = render(<ContextTimelineTick point={point()} />);
    const rail = container.querySelector('[data-timeline-rail]') as HTMLElement;
    const readout = container.querySelector('[data-timeline-readout]') as HTMLElement;
    expect(rail.className).toMatch(/\bleft-\[7px\]/);
    expect(rail.className).not.toMatch(/translate-x/);
    expect(readout.className).toMatch(/\bpl-2\b/);
    expect(readout.className).toMatch(/\bitems-start\b/);
    expect(readout.className).not.toMatch(/\bitems-center\b/);
    expect(readout.className).toMatch(/\brelative\b/);
  });

  it('does not let a jump override the level color', () => {
    const { container } = render(
      <ContextTimelineTick point={point({ isJump: true, delta: 325_000, level: 'critical' })} />,
    );
    expect(rail(container)).toMatch(/bg-red-600/);
    expect(rail(container)).not.toMatch(/amber/);
    expect(screen.getByText(/\+325k/)).toBeInTheDocument();
  });
});

describe('ContextTimelineTick — the rail reads as one line', () => {
  // At a whole-pixel left a 1px rail stays crisp; -translate-x-1/2 put it on
  // half pixels.
  it('draws a hairline rail', () => {
    const { container } = render(<ContextTimelineTick point={point()} />);
    const rail = container.querySelector('[data-timeline-rail]') as HTMLElement;
    expect(rail.className).toMatch(/\bw-px\b/);
    expect(rail.className).not.toMatch(/\bw-0\.5\b/);
    expect(rail.className).not.toMatch(/\bw-1\b/);
  });

  it('spans the full height of its row', () => {
    const { container } = render(<ContextTimelineTick point={point()} />);
    const rail = container.querySelector('[data-timeline-rail]') as HTMLElement;
    expect(rail.className).toMatch(/\binset-y-0\b/);
  });
});

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
  const orderOf = (container: HTMLElement) => {
    const readout = container.querySelector('[data-timeline-readout]') as HTMLElement;
    return Array.from(readout.children).map((c) =>
      (c.textContent ?? '').trim(),
    );
  };

  it('puts the delta above the size it produced', () => {
    const { container } = render(<ContextTimelineTick point={point()} />);
    expect(orderOf(container)).toEqual(['+20k', '120k']);
  });

  it('puts a jump above the size too', () => {
    const { container } = render(
      <ContextTimelineTick point={point({ isJump: true, delta: 325_000 })} />,
    );
    expect(orderOf(container)).toEqual(['+325k', '120k']);
  });

  it('puts the compaction above the size it left', () => {
    const { container } = render(
      <ContextTimelineTick point={point({ isReset: true, delta: null })} />,
    );
    expect(orderOf(container)).toEqual(['+20k', 'compacted', '120k']);
  });

  it('shows the size alone when there is no delta to print', () => {
    const { container } = render(<ContextTimelineTick point={point({ delta: 500 })} viewMode="standard" />);
    expect(orderOf(container)).toEqual(['120k']);
  });
});

describe('ContextTimelineTick — per-turn delta', () => {
  it('prints the delta on an ordinary step, not just on a jump', () => {
    render(<ContextTimelineTick point={point({ delta: 8_000, isJump: false })} />);
    expect(screen.getByText('+8k')).toBeInTheDocument();
  });

  it('prints the drop across a compaction from prevTokens', () => {
    render(
      <ContextTimelineTick
        point={point({ tokens: 80_000, prevTokens: 500_000, delta: null, isReset: true })}
      />,
    );

    expect(screen.getByText('−420k')).toBeInTheDocument();
    expect(screen.getByText('compacted')).toBeInTheDocument();
  });

  it('hides sub-2k deltas in Standard and shows them in Expanded', () => {
    const { rerender } = render(
      <ContextTimelineTick point={point({ delta: 900 })} viewMode="standard" />,
    );
    expect(screen.queryByText('+900')).not.toBeInTheDocument();

    rerender(<ContextTimelineTick point={point({ delta: 900 })} viewMode="expanded" />);
    expect(screen.getByText('+900')).toBeInTheDocument();
  });

  it('offers before → after on hover', () => {
    const { container } = render(<ContextTimelineTick point={point()} />);
    expect(container.firstElementChild).toHaveAttribute('title', expect.stringContaining('100k → 120k'));
  });
});

describe('ContextTimelineTick — delta and reset notes stand out', () => {
  // Border-color utilities lose to the unlayered `* { border-color }` rule, and
  // styles.css sets `.ring-1 { box-shadow: none !important }`.
  const note = (text: RegExp) => screen.getByText(text);

  it('lifts the delta note off the page with a theme-mixed background and edge', () => {
    render(<ContextTimelineTick point={point({ delta: 4_000 })} />);
    const cls = note(/\+4k/).className;
    expect(cls).not.toMatch(/\bbg-muted\b/);
    expect(cls).toMatch(/\bbg-\[color-mix\(in_oklch,var\(--color-foreground\)_\d+%,var\(--color-background\)\)\]/);
    expect(cls).toMatch(/\bshadow-\[inset_0_0_0_1px_color-mix\(in_oklch,var\(--color-foreground\)_\d+%,transparent\)\]/);
    expect(cls).not.toMatch(/\bring-/);
  });

  it('sets an ordinary delta in near-foreground text, not muted gray', () => {
    render(<ContextTimelineTick point={point({ delta: 4_000 })} />);
    const cls = note(/\+4k/).className;
    expect(cls).not.toMatch(/\btext-muted-foreground\b/);
    expect(cls).toMatch(/\btext-foreground\/\d+\b/);
  });

  it('keeps a jump amber', () => {
    render(<ContextTimelineTick point={point({ isJump: true, delta: 325_000 })} />);
    expect(note(/\+325k/).className).toMatch(/\btext-amber-/);
  });

  it('gives the compacted note the same treatment', () => {
    render(<ContextTimelineTick point={point({ isReset: true, delta: null })} />);
    const cls = note(/compacted/).className;
    expect(cls).not.toMatch(/\btext-muted-foreground\b/);
    expect(cls).toMatch(/\bshadow-\[inset_0_0_0_1px_/);
  });
});
