import { describe, it, expect, vi } from 'vitest';
import { dispatchResultNotification } from '../services/sessions/notifications';

describe('dispatchResultNotification', () => {
  it('emits claude-notification, fires showNotification, and increments unread on success', () => {
    const sendToRenderer = vi.fn();
    const showNotification = vi.fn();
    const incrementUnread = vi.fn();

    dispatchResultNotification({
      tabId: 'tab-1',
      projectPath: '/Users/test/proj',
      event: { kind: 'result', isError: false, body: 'Task complete' },
      sendToRenderer,
      notificationHooks: { showNotification, incrementUnread },
    });

    expect(sendToRenderer).toHaveBeenCalledWith('claude-notification', {
      tab_id: 'tab-1',
      title: 'OmniFex — proj',
      body: 'Task complete',
      is_error: false,
    });
    expect(showNotification).toHaveBeenCalledWith(
      'OmniFex — proj',
      'Task complete',
      false,
      { tabId: 'tab-1' },
    );
    expect(incrementUnread).toHaveBeenCalledTimes(1);
  });

  it('marks the notification as an error when the result event is an error', () => {
    const sendToRenderer = vi.fn();
    const showNotification = vi.fn();

    dispatchResultNotification({
      tabId: 'tab-2',
      projectPath: '/p',
      event: { kind: 'result', isError: true, body: 'Task failed' },
      sendToRenderer,
      notificationHooks: { showNotification },
    });

    expect(sendToRenderer).toHaveBeenCalledWith('claude-notification', expect.objectContaining({ is_error: true }));
    expect(showNotification).toHaveBeenCalledWith(expect.any(String), 'Task failed', true, { tabId: 'tab-2' });
  });

  it('swallows hook errors without throwing; subsequent hooks in the catch are skipped', () => {
    const sendToRenderer = vi.fn();
    const showNotification = vi.fn(() => { throw new Error('boom'); });
    const incrementUnread = vi.fn();

    expect(() => dispatchResultNotification({
      tabId: 'tab-3',
      projectPath: '/p',
      event: { kind: 'result', isError: false, body: 'done' },
      sendToRenderer,
      notificationHooks: { showNotification, incrementUnread },
    })).not.toThrow();

    // Behavior preserved from the original runtime.ts block: a throwing
    // showNotification short-circuits the shared try/catch, so
    // incrementUnread does not fire. The renderer-side claude-notification
    // IPC has already been emitted by this point.
    expect(sendToRenderer).toHaveBeenCalledWith('claude-notification', expect.any(Object));
    expect(incrementUnread).not.toHaveBeenCalled();
  });
});
