// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueuedPromptsPanel } from '../QueuedPromptsPanel';
import { TooltipProvider } from '@/components/ui/tooltip-modern';

const prompts = [
  { id: 'a', prompt: 'first thing', model: 'default' },
  { id: 'b', prompt: 'second thing', model: 'sonnet' },
];

function renderPanel(overrides: Partial<React.ComponentProps<typeof QueuedPromptsPanel>> = {}) {
  const props = {
    prompts,
    modelLabel: (id: string) => (id === 'default' ? 'Opus 5.5 *' : 'Sonnet'),
    onRemove: vi.fn(),
    onSave: vi.fn(),
    onEditingChange: vi.fn(),
    ...overrides,
  };
  const utils = render(<QueuedPromptsPanel {...props} />, { wrapper: TooltipProvider });
  return { ...utils, props };
}

afterEach(cleanup);

describe('QueuedPromptsPanel', () => {
  it('labels each prompt with the resolved model name', () => {
    renderPanel();
    expect(screen.getByText('Opus 5.5 *')).toBeTruthy();
    expect(screen.getByText('Sonnet')).toBeTruthy();
  });

  it('opens a prompt for editing when its text is clicked', () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByText('second thing'));
    const box = screen.getByRole('textbox', { name: 'Edit queued prompt 2' });
    expect(box).toHaveProperty('value', 'second thing');
    expect(props.onEditingChange).toHaveBeenLastCalledWith('b');
  });

  it('saves the edited text on Enter and releases the hold', () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByText('first thing'));
    const box = screen.getByRole('textbox', { name: 'Edit queued prompt 1' });
    fireEvent.change(box, { target: { value: 'first thing, revised' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(props.onSave).toHaveBeenCalledWith('a', 'first thing, revised');
    expect(props.onEditingChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('keeps Shift+Enter as a newline rather than a save', () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByText('first thing'));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: true });
    expect(props.onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('discards the edit on Escape', () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByText('first thing'));
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'nope' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onEditingChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByText('first thing')).toBeTruthy();
  });

  // An edit left open holds the queue; clicking away must not strand it.
  it('saves on blur so a forgotten edit never holds the queue', () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByText('first thing'));
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'changed' } });
    fireEvent.blur(box);
    expect(props.onSave).toHaveBeenCalledWith('a', 'changed');
    expect(props.onEditingChange).toHaveBeenLastCalledWith(null);
  });

  it('saves once when Enter is followed by the blur of the closing textarea', () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByText('first thing'));
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'changed' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.blur(box);
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });

  // An empty queued prompt would send an empty turn. Removing is ✕'s job.
  it('treats saving blank text as a cancel', () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByText('first thing'));
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onEditingChange).toHaveBeenLastCalledWith(null);
  });

  it('releases the hold when the prompt being edited leaves the queue', () => {
    const { props, rerender } = renderPanel();
    fireEvent.click(screen.getByText('first thing'));
    rerender(<QueuedPromptsPanel {...props} prompts={[prompts[1]]} />);
    expect(props.onEditingChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('removes a prompt with its ✕ button', () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getAllByTitle('Remove from queue')[1]);
    expect(props.onRemove).toHaveBeenCalledWith('b');
  });
});
