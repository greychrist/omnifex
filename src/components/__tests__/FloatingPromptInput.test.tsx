// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
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

  it('keeps the output toggle in a full-width column on the left', () => {
    render(
      <FloatingPromptInput
        onSend={vi.fn()}
        outputStyleToggle={<div data-testid="output-toggle" />}
        extraMenuItems={
          <>
            <button data-testid="extra-1" />
            <button data-testid="extra-2" />
          </>
        }
      />,
    );

    const output = screen.getByTestId('output-toggle');
    expect(output.parentElement?.className).toContain('flex-col');
    expect(output.parentElement?.className).toContain('items-stretch');
    // Narrow enough for the toggle alone: its label stacks above it rather
    // than sitting beside it, so the column no longer pays for both.
    expect(output.parentElement?.className).toContain('w-40');
    expect(output.parentElement?.className).not.toContain('w-52');
    // Extras sit in a 3-up grid on the right: six of them are two rows, not
    // three, which is what sets the bar's height.
    expect(screen.getByTestId('extra-1').parentElement?.className).toContain('grid-cols-3');
  });

  it('lets the input fill the bar height and pins both side stacks to the top', () => {
    render(
      <FloatingPromptInput
        onSend={vi.fn()}
        outputStyleToggle={<div data-testid="output-toggle" />}
        extraMenuItems={
          <>
            <button data-testid="extra-1" />
            <button data-testid="extra-2" />
          </>
        }
      />,
    );

    const stack = screen.getByTestId('output-toggle').parentElement!;
    const row = stack.parentElement!;
    // The bar's height is set by whichever side stack is taller; the row
    // must stretch its children rather than sit them on the baseline.
    expect(row.className).toContain('items-stretch');
    expect(row.className).not.toContain('items-end');
    // Both side stacks hug the top of that height.
    expect(stack.className).toContain('self-start');
    expect(screen.getByTestId('extra-1').parentElement?.className).toContain('self-start');

    // The textarea fills the stretched middle column, with the auto-grow
    // measurement kept as its floor.
    const textarea = screen.getByPlaceholderText(/Message Claude/);
    expect(textarea.className).toContain('h-full');
    expect(textarea.style.minHeight).toBe('72px');
    expect(textarea.style.height).toBe('');
  });

  it('keeps the 72px floor while empty: the placeholder must not size the bar', () => {
    // A narrow textarea wraps the placeholder onto several lines, and the
    // auto-grow used to read THAT as content height. The first keystroke
    // removes the placeholder, the floor drops, and the whole bar shrinks.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 130 });
    try {
      render(<FloatingPromptInput onSend={vi.fn()} />);
      const textarea = screen.getByPlaceholderText(/Message Claude/) as HTMLTextAreaElement;
      expect(textarea.style.minHeight).toBe('72px');

      fireEvent.change(textarea, { target: { value: 'hello' } });
      expect(textarea.style.minHeight).toBe('130px');

      fireEvent.change(textarea, { target: { value: '' } });
      expect(textarea.style.minHeight).toBe('72px');
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', original);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
    }
  });
});
