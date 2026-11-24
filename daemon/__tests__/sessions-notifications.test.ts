import { describe, it, expect, vi } from 'vitest';
import { dispatchResultNotification, dispatchAgentNotification } from '../services/sessions/notifications';

const banner = (sendToRenderer: ReturnType<typeof vi.fn>) =>
  sendToRenderer.mock.calls.filter(([ch]) => ch === 'claude-notification').map(([, p]) => p);

describe('dispatchResultNotification', () => {
  it('emits claude-notification for the tab', () => {
    const sendToRenderer = vi.fn();
    dispatchResultNotification({
      tabId: 'tab-1',
      projectPath: '/Users/test/proj',
      event: { kind: 'result', isError: false, body: 'Task complete' },
      sendToRenderer,
    });
    expect(banner(sendToRenderer)).toEqual([{
      tab_id: 'tab-1',
      title: 'OmniFex — proj',
      body: 'Task complete',
      is_error: false,
    }]);
  });

  it('marks the notification as an error when the result event is an error', () => {
    const sendToRenderer = vi.fn();
    dispatchResultNotification({
      tabId: 'tab-2',
      projectPath: '/p',
      event: { kind: 'result', isError: true, body: 'Task failed' },
      sendToRenderer,
    });
    expect(banner(sendToRenderer)).toEqual([expect.objectContaining({ is_error: true, body: 'Task failed' })]);
  });
});

describe('dispatchAgentNotification', () => {
  it('tells the user their background agent finished, and how long it took', () => {
    const sendToRenderer = vi.fn();
    dispatchAgentNotification({
      tabId: 'tab-1',
      projectPath: '/Users/test/pi-tuitive',
      description: 'Adversarial pre-push review',
      event: { kind: 'taskNotification', taskId: 'a53f', status: 'completed', summary: 'No blockers.', durationMs: 44630 },
      sendToRenderer,
    });
    expect(banner(sendToRenderer)).toEqual([{
      tab_id: 'tab-1',
      title: 'OmniFex — pi-tuitive',
      body: 'Agent finished: Adversarial pre-push review · 45s',
      is_error: false,
    }]);
  });

  it('marks a failed agent as an error', () => {
    const sendToRenderer = vi.fn();
    dispatchAgentNotification({
      tabId: 'tab-2',
      projectPath: '/p',
      description: 'Task 6 reviewer',
      event: { kind: 'taskNotification', taskId: 't', status: 'failed', summary: '', durationMs: null },
      sendToRenderer,
    });
    expect(banner(sendToRenderer)).toEqual([expect.objectContaining({ body: 'Agent failed: Task 6 reviewer', is_error: true })]);
  });

  it('formats a long run in minutes', () => {
    const sendToRenderer = vi.fn();
    dispatchAgentNotification({
      tabId: 't', projectPath: '/p', description: 'Fresh re-review of full diff',
      event: { kind: 'taskNotification', taskId: 't', status: 'completed', summary: '', durationMs: 12 * 60_000 + 4_000 },
      sendToRenderer,
    });
    expect(banner(sendToRenderer)[0]).toMatchObject({ body: 'Agent finished: Fresh re-review of full diff · 12m 04s' });
  });

  it('falls back to a generic label when the agent had no description', () => {
    const sendToRenderer = vi.fn();
    dispatchAgentNotification({
      tabId: 't', projectPath: '/p', description: '',
      event: { kind: 'taskNotification', taskId: 't', status: 'completed', summary: '', durationMs: null },
      sendToRenderer,
    });
    expect(banner(sendToRenderer)[0]).toMatchObject({ body: 'Agent finished' });
  });
});
