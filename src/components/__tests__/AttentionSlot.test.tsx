// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AttentionSlot } from '../AttentionSlot';
import type { SessionSignal, SignalPriority } from '@/lib/signals/types';

afterEach(() => {
  cleanup();
});

function action(
  key: string,
  over: Partial<SessionSignal> & { priority?: SignalPriority } = {},
): SessionSignal {
  return {
    id: key,
    tabId: 'tab-1',
    kind: 'action',
    anchor: 'session',
    priority: 'normal',
    key,
    title: `Title for ${key}`,
    at: 1000,
    actions: [{ id: 'go', label: 'Do it', run: () => {} }],
    ...over,
  };
}

describe('AttentionSlot', () => {
  it('renders nothing at all when the queue is empty', () => {
    const { container } = render(<AttentionSlot queue={[]} onDismiss={() => {}} />);

    // Not "renders an empty box": the slot sits in a flex column above the
    // composer, so an empty wrapper would still push the layout.
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the first item with its actions', () => {
    render(<AttentionSlot queue={[action('context.boundary')]} onDismiss={() => {}} />);

    expect(screen.getByText('Title for context.boundary')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Do it' })).toBeInTheDocument();
  });

  it('runs the action when its button is pressed', () => {
    const run = vi.fn();
    const item = action('context.boundary', { actions: [{ id: 'go', label: 'Compact now', run }] });
    render(<AttentionSlot queue={[item]} onDismiss={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }));
    expect(run).toHaveBeenCalledOnce();
  });

  it('honours a disabled action rather than hiding it', () => {
    const run = vi.fn();
    const item = action('context.boundary', {
      actions: [{ id: 'go', label: 'Compact now', run, disabled: true }],
    });
    render(<AttentionSlot queue={[item]} onDismiss={() => {}} />);

    expect(screen.getByRole('button', { name: 'Compact now' })).toBeDisabled();
  });

  it('never stacks two items — one row, with a counter for the rest', () => {
    render(
      <AttentionSlot
        queue={[action('a'), action('b'), action('c')]}
        onDismiss={() => {}}
      />,
    );

    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    expect(screen.queryByText('Title for b')).not.toBeInTheDocument();
  });

  it('hides the counter and its controls for a single item', () => {
    render(<AttentionSlot queue={[action('a')]} onDismiss={() => {}} />);

    expect(screen.queryByText(/of 1/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /next attention item/i })).not.toBeInTheDocument();
  });

  it('steps through the queue', () => {
    render(<AttentionSlot queue={[action('a'), action('b')]} onDismiss={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /next attention item/i }));
    expect(screen.getByText('Title for b')).toBeInTheDocument();
    expect(screen.getByText('2 of 2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /previous attention item/i }));
    expect(screen.getByText('Title for a')).toBeInTheDocument();
  });

  it('wraps rather than dead-ending at either edge', () => {
    render(<AttentionSlot queue={[action('a'), action('b')]} onDismiss={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /previous attention item/i }));
    expect(screen.getByText('Title for b')).toBeInTheDocument();
  });

  it('dismisses by key', () => {
    const onDismiss = vi.fn();
    render(<AttentionSlot queue={[action('context.boundary')]} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledWith('context.boundary');
  });

  it('clamps the cursor when the queue shrinks under it', () => {
    // Resolving the item you were looking at must not leave the slot pointing
    // past the end of the queue and rendering nothing.
    const { rerender } = render(
      <AttentionSlot queue={[action('a'), action('b')]} onDismiss={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /next attention item/i }));

    rerender(<AttentionSlot queue={[action('a')]} onDismiss={() => {}} />);
    expect(screen.getByText('Title for a')).toBeInTheDocument();
  });

  it('announces itself politely for screen readers', () => {
    render(<AttentionSlot queue={[action('a')]} onDismiss={() => {}} />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });
});
