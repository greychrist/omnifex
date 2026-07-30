// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ContextPressureBanner } from '../ContextPressureBanner';
import { evaluateContextPressure, DEFAULT_CONTEXT_PRESSURE } from '@/lib/contextPressure';

afterEach(() => {
  cleanup();
});

/** A 1M-window session at `tokens`, under the shipped 250k default. */
const pressureAt = (tokens: number, limit = 1_000_000) =>
  evaluateContextPressure({ tokens, limit, setting: DEFAULT_CONTEXT_PRESSURE });

const renderAt = (tokens: number, over: { busy?: boolean; onCompact?: () => void } = {}) => {
  const limit = 1_000_000;
  return render(
    <ContextPressureBanner
      pressure={pressureAt(tokens, limit)}
      tokens={tokens}
      limit={limit}
      busy={over.busy ?? false}
      onCompact={over.onCompact ?? (() => {})}
    />,
  );
};

describe('ContextPressureBanner', () => {
  it('renders nothing below the warn line', () => {
    const { container } = renderAt(100_000);
    expect(container).toBeEmptyDOMElement();
  });

  it('warns in amber at 80% of the budget', () => {
    renderAt(200_000);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('amber');
    expect(btn.className).not.toContain('red');
  });

  it('escalates to red at the budget', () => {
    renderAt(250_000);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('red');
    expect(btn.className).not.toContain('amber');
  });

  it('states the occupancy, the window and the threshold', () => {
    renderAt(250_000);
    const text = screen.getByRole('button').textContent ?? '';
    expect(text).toContain('250k');
    expect(text).toContain('1.0M');
    expect(text).toContain('25%');
    expect(text).toContain('/compact');
  });

  it('distinguishes approaching the threshold from being over it', () => {
    const { unmount } = renderAt(200_000);
    expect(screen.getByRole('button').textContent).toContain('80% of your');
    unmount();
    renderAt(250_000);
    expect(screen.getByRole('button').textContent).toContain('over your');
  });

  it('runs /compact when clicked', () => {
    const onCompact = vi.fn();
    renderAt(250_000, { onCompact });
    fireEvent.click(screen.getByRole('button'));
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  // The product decision: a dismissible warning becomes a reflex-dismissed
  // warning. The banner clears only when context actually drops, or when the
  // setting is turned off. This is the regression guard on that.
  it('has no dismiss control', () => {
    renderAt(250_000);
    expect(screen.queryByLabelText('Dismiss')).toBeNull();
    // The banner itself is the only button in the row.
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('is inert while a turn is in flight', () => {
    const onCompact = vi.fn();
    renderAt(250_000, { busy: true, onCompact });
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn.textContent).toContain('waiting for the current turn');
    fireEvent.click(btn);
    expect(onCompact).not.toHaveBeenCalled();
  });
});
