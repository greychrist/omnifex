// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SideChatPanel } from '../SideChatPanel';
import type { SideChat, SideChatExchange } from '@/lib/sideChat';

const chat = (exchanges: SideChatExchange[]): SideChat => ({ exchanges });
const ex = (over: Partial<SideChatExchange>): SideChatExchange => ({
  id: 'sq-1', question: 'Q?', askedAt: 't', status: 'answered', answer: 'A.', ...over,
});

afterEach(cleanup);

describe('SideChatPanel', () => {
  it('renders each status', () => {
    render(<SideChatPanel askError={null} onAsk={vi.fn()} onClose={vi.fn()} sideChat={chat([
      ex({ id: '1', answer: '**bold**' }),
      ex({ id: '2', status: 'no-answer', answer: undefined }),
      ex({ id: '3', status: 'failed', answer: undefined, error: 'boom' }),
      ex({ id: '4', status: 'pending', answer: undefined }),
    ])} />);
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('No answer')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.getByText('Thinking…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Enter sends and clears; Shift+Enter does not send', async () => {
    const onAsk = vi.fn().mockResolvedValue(true);
    render(<SideChatPanel askError={null} onAsk={onAsk} onClose={vi.fn()} sideChat={chat([])} />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onAsk).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onAsk).toHaveBeenCalledWith('hello');
    await vi.waitFor(() => { expect(box.value).toBe(''); });
  });

  it('keeps the draft when the ask is rejected', async () => {
    const onAsk = vi.fn().mockResolvedValue(false);
    render(<SideChatPanel askError={null} onAsk={onAsk} onClose={vi.fn()} sideChat={chat([])} />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await vi.waitFor(() => { expect(onAsk).toHaveBeenCalled(); });
    expect(box.value).toBe('hello');
  });

  it('Retry re-asks a failed question', () => {
    const onAsk = vi.fn().mockResolvedValue(true);
    render(<SideChatPanel askError={null} onAsk={onAsk} onClose={vi.fn()} sideChat={chat([ex({ status: 'failed', error: 'x', answer: undefined })])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onAsk).toHaveBeenCalledWith('Q?');
  });

  it('closing a non-empty chat asks first; an empty one closes at once', () => {
    const onClose = vi.fn();
    const { rerender } = render(<SideChatPanel askError={null} onAsk={vi.fn()} onClose={onClose} sideChat={chat([ex({})])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Side chat' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<SideChatPanel askError={null} onAsk={vi.fn()} onClose={onClose} sideChat={chat([])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Side chat' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Keep dismisses the confirm without closing', () => {
    const onClose = vi.fn();
    render(<SideChatPanel askError={null} onAsk={vi.fn()} onClose={onClose} sideChat={chat([ex({})])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Side chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText('Discard this side chat?')).toBeNull();
  });

  it('shows an ask error', () => {
    render(<SideChatPanel askError="No live session" onAsk={vi.fn()} onClose={vi.fn()} sideChat={chat([])} />);
    expect(screen.getByText('No live session')).toBeTruthy();
  });
});
