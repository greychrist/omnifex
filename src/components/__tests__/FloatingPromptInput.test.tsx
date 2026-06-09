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

describe('FloatingPromptInput — control picker column', () => {
  it('shows full value labels (session-start style), not compact short names', () => {
    render(
      <FloatingPromptInput
        onSend={vi.fn()}
        defaultModel="sonnet"
        permissionMode="default"
        effort="high"
      />,
    );

    // Full names from the form-variant pickers...
    expect(screen.getAllByText('Sonnet').length).toBeGreaterThan(0);
    expect(screen.getAllByText('High').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Default').length).toBeGreaterThan(0);
    // ...and none of the compact-trigger abbreviations.
    expect(screen.queryByText('S')).toBeNull();   // model shortName
    expect(screen.queryByText('Hi')).toBeNull();  // effort shortName
    expect(screen.queryByText('DEF')).toBeNull(); // permission shortName
  });

  it('renders mode and output toggles stacked on the right with the extras grid', () => {
    render(
      <FloatingPromptInput
        onSend={vi.fn()}
        modeToggle={<div data-testid="mode-toggle" />}
        outputStyleToggle={<div data-testid="output-toggle" />}
        extraMenuItems={
          <>
            <button data-testid="extra-1" />
            <button data-testid="extra-2" />
            <button data-testid="extra-3" />
            <button data-testid="extra-4" />
          </>
        }
      />,
    );

    const mode = screen.getByTestId('mode-toggle');
    const output = screen.getByTestId('output-toggle');
    // Both toggles live in the same vertical stack container.
    expect(mode.parentElement).toBe(output.parentElement);
    // Extras render inside a 2-column grid (the "square").
    const extras = screen.getByTestId('extra-1');
    expect(extras.parentElement?.className).toContain('grid-cols-2');
  });
});
