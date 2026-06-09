// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { FloatingPromptInput } from '../FloatingPromptInput';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, listSupportedModels: vi.fn(async () => []) },
  };
});

afterEach(() => { cleanup(); });

describe('FloatingPromptInput — chat bar layout', () => {
  it('hosts no model/effort/permission pickers (they live in the session popover)', () => {
    render(<FloatingPromptInput onSend={vi.fn()} defaultModel="sonnet" />);

    // Form-picker value labels must NOT render in the bar anymore.
    expect(screen.queryByText('Sonnet')).toBeNull();
    expect(screen.queryByText('High')).toBeNull();
    expect(screen.queryByText('Default')).toBeNull();
  });

  it('stacks the mode and output toggles vertically on the left at equal widths', () => {
    render(
      <FloatingPromptInput
        onSend={vi.fn()}
        modeToggle={<div data-testid="mode-toggle" />}
        outputStyleToggle={<div data-testid="output-toggle" />}
        extraMenuItems={
          <>
            <button data-testid="extra-1" />
            <button data-testid="extra-2" />
          </>
        }
      />,
    );

    const mode = screen.getByTestId('mode-toggle');
    const output = screen.getByTestId('output-toggle');
    // Same vertical stack, full-width children → equal widths.
    expect(mode.parentElement).toBe(output.parentElement);
    expect(mode.parentElement?.className).toContain('flex-col');
    expect(mode.parentElement?.className).toContain('items-stretch');
    // Extras keep their square grid on the right.
    expect(screen.getByTestId('extra-1').parentElement?.className).toContain('grid-cols-2');
  });
});
