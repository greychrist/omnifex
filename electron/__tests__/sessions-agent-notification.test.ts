import { describe, it, expect, vi } from 'vitest';
import { listenToMessages } from '../services/sessions/runtime';
import type { SessionHandle } from '../services/sessions/types';

/**
 * Drives the runtime's engine listener with the exact message sequence a
 * backgrounded agent produces, captured from a live 2.1.235 stream.
 */
function harness() {
  const messageCbs: Array<(m: unknown) => void> = [];
  const showNotification = vi.fn();
  const engine = {
    onMessage: (cb: (m: unknown) => void) => { messageCbs.push(cb); return { dispose: () => {} }; },
    onError: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    onPermissionRequest: () => ({ dispose: () => {} }),
    getInitData: () => null,
  };
  const handle = {
    engine,
    projectPath: '/Users/test/pi-tuitive',
    configDir: '/cfg',
    sessionId: null,
  } as unknown as SessionHandle;

  void listenToMessages('tab-1', handle, {
    sendToRenderer: vi.fn(),
    notificationHooks: { showNotification, incrementUnread: vi.fn() },
    rateLimitHook: null,
    ownership: null,
    sessions: new Map(),
  });

  const emit = (payload: unknown) => {
    for (const cb of messageCbs) cb({ agent: 'claude', tabId: 'tab-1', receivedAt: '', sessionId: null, payload });
  };
  return { emit, showNotification };
}

describe('background agent completion notification', () => {
  it('fires when the agent finishes, long after its launching turn ended', () => {
    const { emit, showNotification } = harness();
    emit({
      type: 'system', subtype: 'task_started', task_id: 'a53f', tool_use_id: 'toolu_1',
      description: 'Adversarial pre-push review', subagent_type: 'general-purpose', task_type: 'local_agent',
    });
    // The turn that launched it ends here — this is the notification the
    // user already gets, minutes before the agent is actually done.
    emit({ type: 'result', subtype: 'success', result: 'dispatched' });
    expect(showNotification).toHaveBeenCalledTimes(1);

    emit({
      type: 'system', subtype: 'task_notification', task_id: 'a53f', tool_use_id: 'toolu_1',
      status: 'completed', summary: 'No blockers.', usage: { duration_ms: 44630 },
    });
    expect(showNotification).toHaveBeenCalledTimes(2);
    expect(showNotification).toHaveBeenLastCalledWith(
      'OmniFex — pi-tuitive',
      'Agent finished: Adversarial pre-push review · 45s',
      false,
      { tabId: 'tab-1' },
    );
  });

  it('stays silent for a backgrounded shell', () => {
    const { emit, showNotification } = harness();
    emit({
      type: 'system', subtype: 'task_started', task_id: 'bnnc', owned_by_subagent: true,
      tool_use_id: 'toolu_2', description: 'Sleep 40 seconds in background', task_type: 'local_bash',
    });
    emit({
      type: 'system', subtype: 'task_notification', task_id: 'bnnc', tool_use_id: 'toolu_2',
      status: 'completed', summary: 'Background command completed (exit code 0)',
    });
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('stays silent for a task it never saw start (attached mid-run)', () => {
    const { emit, showNotification } = harness();
    emit({
      type: 'system', subtype: 'task_notification', task_id: 'orphan',
      status: 'completed', summary: 'done',
    });
    expect(showNotification).not.toHaveBeenCalled();
  });
});
