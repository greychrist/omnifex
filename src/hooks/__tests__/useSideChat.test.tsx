// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';

const api = vi.hoisted(() => ({
  sessionGetSideChat: vi.fn(),
  sessionSideChatAsk: vi.fn(),
  sessionSideChatClose: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api }));

import { useSideChat } from '../useSideChat';

let listener: ((p: unknown) => void) | null = null;
beforeEach(() => {
  listener = null;
  api.sessionGetSideChat.mockResolvedValue({ exchanges: [{ id: 'sq-1', question: 'seeded', askedAt: 't', status: 'answered', answer: 'yes' }] });
  api.sessionSideChatAsk.mockResolvedValue({ ok: true });
  api.sessionSideChatClose.mockResolvedValue(undefined);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    onEvent: vi.fn((ch: string, cb: (p: unknown) => void) => {
      if (ch === 'session-side-chat:tab1') listener = cb;
      return () => {};
    }),
  };
});

afterEach(cleanup);

describe('useSideChat', () => {
  it('seeds from the service, then applies pushed snapshots', async () => {
    const { result } = renderHook(() => useSideChat('tab1'));
    await waitFor(() => { expect(result.current.sideChat.exchanges[0]?.question).toBe('seeded'); });
    act(() => { listener?.({ exchanges: [] }); });
    expect(result.current.sideChat.exchanges).toEqual([]);
  });

  it('surfaces a rejected ask as askError, and clears it on success', async () => {
    api.sessionSideChatAsk.mockResolvedValueOnce({ ok: false, error: 'No live session' });
    const { result } = renderHook(() => useSideChat('tab1'));
    let ok = true;
    await act(async () => { ok = await result.current.ask('q'); });
    expect(ok).toBe(false);
    expect(result.current.askError).toBe('No live session');
    await act(async () => { ok = await result.current.ask('q'); });
    expect(ok).toBe(true);
    expect(result.current.askError).toBeNull();
  });

  it('close calls the service', () => {
    const { result } = renderHook(() => useSideChat('tab1'));
    act(() => { result.current.close(); });
    expect(api.sessionSideChatClose).toHaveBeenCalledWith('tab1');
  });
});
