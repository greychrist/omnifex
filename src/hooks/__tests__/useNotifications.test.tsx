// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useNotifications } from '../useNotifications';

let handler: ((p: unknown) => void) | null = null;
beforeEach(() => {
  handler = null;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    onEvent: vi.fn((_ch: string, cb: (p: unknown) => void) => { handler = cb; return () => {}; }),
  };
});

describe('useNotifications', () => {
  it('marks a background tab unread for a result notification', () => {
    const updateTab = vi.fn();
    renderHook(() => useNotifications('active', vi.fn(), updateTab));
    handler?.({ tab_id: 'other', title: 't', body: 'b', is_error: false });
    expect(updateTab).toHaveBeenCalledWith('other', { hasUnreadResult: true });
  });

  it('leaves the tab alone for a mod notification', () => {
    const updateTab = vi.fn();
    renderHook(() => useNotifications('active', vi.fn(), updateTab));
    handler?.({ tab_id: 'other', title: 't', body: 'b', is_error: false, origin: 'mod' });
    expect(updateTab).not.toHaveBeenCalled();
  });
});
