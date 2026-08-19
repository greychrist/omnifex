import { describe, it, expect, vi } from 'vitest';
import { dispatchResultNotification, dispatchAgentNotification } from '../services/sessions/notifications';

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

describe('dispatchAgentNotification', () => {
  it('tells the user their background agent finished, and how long it took', () => {
    // The whole point: a backgrounded agent finishes long after the `result`
    // notification for the turn that launched it, so nothing else in the app
    // will say so if the user is in another tab or another app.
    const sendToRenderer = vi.fn();
    const showNotification = vi.fn();
    const incrementUnread = vi.fn();

    dispatchAgentNotification({
      tabId: 'tab-1',
      projectPath: '/Users/test/pi-tuitive',
      description: 'Adversarial pre-push review',
      event: { kind: 'taskNotification', taskId: 'a53f', status: 'completed', summary: 'No blockers.', durationMs: 44630 },
      sendToRenderer,
      notificationHooks: { showNotification, incrementUnread },
    });

    expect(sendToRenderer).toHaveBeenCalledWith('claude-notification', {
      tab_id: 'tab-1',
      title: 'OmniFex — pi-tuitive',
      body: 'Agent finished: Adversarial pre-push review · 45s',
      is_error: false,
    });
    expect(showNotification).toHaveBeenCalledWith(
      'OmniFex — pi-tuitive',
      'Agent finished: Adversarial pre-push review · 45s',
      false,
      { tabId: 'tab-1' },
    );
    expect(incrementUnread).toHaveBeenCalledTimes(1);
  });

  it('marks a failed agent as an error', () => {
    const sendToRenderer = vi.fn();
    const showNotification = vi.fn();
    dispatchAgentNotification({
      tabId: 'tab-2',
      projectPath: '/p',
      description: 'Task 6 reviewer',
      event: { kind: 'taskNotification', taskId: 't', status: 'failed', summary: '', durationMs: null },
      sendToRenderer,
      notificationHooks: { showNotification },
    });
    expect(showNotification).toHaveBeenCalledWith(expect.any(String), 'Agent failed: Task 6 reviewer', true, { tabId: 'tab-2' });
  });

  it('formats a long run in minutes', () => {
    const showNotification = vi.fn();
    dispatchAgentNotification({
      tabId: 't', projectPath: '/p', description: 'Fresh re-review of full diff',
      event: { kind: 'taskNotification', taskId: 't', status: 'completed', summary: '', durationMs: 12 * 60_000 + 4_000 },
      sendToRenderer: vi.fn(), notificationHooks: { showNotification },
    });
    expect(showNotification).toHaveBeenCalledWith(expect.any(String), 'Agent finished: Fresh re-review of full diff · 12m 04s', false, { tabId: 't' });
  });

  it('falls back to a generic label when the agent had no description', () => {
    const showNotification = vi.fn();
    dispatchAgentNotification({
      tabId: 't', projectPath: '/p', description: '',
      event: { kind: 'taskNotification', taskId: 't', status: 'completed', summary: '', durationMs: null },
      sendToRenderer: vi.fn(), notificationHooks: { showNotification },
    });
    expect(showNotification).toHaveBeenCalledWith(expect.any(String), 'Agent finished', false, { tabId: 't' });
  });

  it('swallows hook errors without throwing', () => {
    expect(() => dispatchAgentNotification({
      tabId: 't', projectPath: '/p', description: 'x',
      event: { kind: 'taskNotification', taskId: 't', status: 'completed', summary: '', durationMs: null },
      sendToRenderer: vi.fn(),
      notificationHooks: { showNotification: () => { throw new Error('boom'); } },
    })).not.toThrow();
  });
});
