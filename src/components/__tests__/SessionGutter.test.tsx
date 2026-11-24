// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip-modern';
import { SessionGutter, InspectorGutterButton, GUTTER_BUTTON, GUTTER_GROUP_BUTTON } from '@/components/SessionGutter';

const withTooltips = (ui: React.ReactNode) => render(<TooltipProvider>{ui}</TooltipProvider>);

afterEach(() => { cleanup(); });

describe('InspectorGutterButton', () => {
  it('opens the inspector', () => {
    const onOpenInspector = vi.fn();
    withTooltips(<InspectorGutterButton onOpenInspector={onOpenInspector} inspectorOpen={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show session inspector' }));
    expect(onOpenInspector).toHaveBeenCalledTimes(1);
  });

  it('stands down while the inspector is already open', () => {
    const { container } = render(
      <InspectorGutterButton onOpenInspector={() => {}} inspectorOpen />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing on a surface with no inspector to open', () => {
    const { container } = render(<InspectorGutterButton inspectorOpen={false} />);
    expect(container.innerHTML).toBe('');
  });

  it('wears the same button chrome as the steppers it now sits above', () => {
    withTooltips(<InspectorGutterButton onOpenInspector={() => {}} inspectorOpen={false} />);
    const cls = screen.getByRole('button', { name: 'Show session inspector' }).className;
    expect(cls).toContain('h-8');
    expect(cls).toContain('w-8');
    expect(cls).toContain('backdrop-blur-sm');
  });
});

describe('SessionGutter', () => {
  const rail = (c: HTMLElement) => c.firstElementChild as HTMLElement;

  it('pins the top slot to the top edge and the children to the bottom', () => {
    const { container } = render(
      <SessionGutter top={<button type="button">inspector</button>}>
        <button type="button">first</button>
        <button type="button">second</button>
      </SessionGutter>,
    );
    expect(rail(container).className).toContain('justify-between');

    const topGroup = screen.getByTestId('gutter-top');
    const bottomGroup = screen.getByTestId('gutter-bottom');
    expect([...topGroup.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['inspector']);
    expect([...bottomGroup.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['first', 'second']);

    expect(topGroup.contains(bottomGroup)).toBe(false);
  });

  it('spans the full height of the rail', () => {
    const { container } = render(<SessionGutter top={null}>{null}</SessionGutter>);
    const cls = rail(container).className;
    expect(cls).toContain('absolute');
    expect(cls).toContain('right-1');
    expect(cls).toContain('top-2');
    expect(cls).toContain('bottom-6');
  });

  it('lets pointer events through everywhere except the two button groups', () => {
    const { container } = render(
      <SessionGutter top={<button type="button">a</button>}>
        <button type="button">b</button>
      </SessionGutter>,
    );
    expect(rail(container).className).toContain('pointer-events-none');
    expect(screen.getByTestId('gutter-top').className).toContain('pointer-events-auto');
    expect(screen.getByTestId('gutter-bottom').className).toContain('pointer-events-auto');
  });
});

// Tailwind width token → px (w-8 = 32px, w-[30px] = 30px).
function widthPx(classes: string): number {
  const m = classes.split(/\s+/).find((c) => /^w-(\d+|\[\d+px\])$/.test(c));
  if (!m) throw new Error(`no width class in "${classes}"`);
  const arb = /^w-\[(\d+)px\]$/.exec(m);
  return arb ? Number(arb[1]) : Number(m.slice(2)) * 4;
}

describe('gutter button widths', () => {
  it('a standalone rail button is as wide as a button group', () => {
    // A standalone button's border is inside its width; a group draws its 1px
    // border outside, so a grouped button is 2px narrower.
    expect(widthPx(GUTTER_GROUP_BUTTON) + 2).toBe(widthPx(GUTTER_BUTTON));
  });
});
