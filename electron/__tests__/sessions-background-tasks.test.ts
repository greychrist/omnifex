import { describe, it, expect } from 'vitest';
import { createBackgroundTaskTracker } from '../services/sessions/background-tasks';

describe('createBackgroundTaskTracker', () => {
  it('resolves an agent notification back to the agent that started', () => {
    // `task_notification` carries no task_type, so without the `task_started`
    // it followed there is no way to know an agent (rather than a shell)
    // just finished, nor what it was called.
    const tracker = createBackgroundTaskTracker();
    tracker.started({ kind: 'taskStarted', taskId: 'a53f', taskType: 'local_agent', description: 'Adversarial pre-push review' });
    expect(tracker.resolveAgent('a53f')).toEqual({ description: 'Adversarial pre-push review' });
  });

  it('ignores a backgrounded shell — only agents are worth interrupting the user for', () => {
    const tracker = createBackgroundTaskTracker();
    tracker.started({ kind: 'taskStarted', taskId: 'bnnc', taskType: 'local_bash', description: 'Sleep 40 seconds in background' });
    expect(tracker.resolveAgent('bnnc')).toBeNull();
  });

  it('ignores a task it never saw start', () => {
    expect(createBackgroundTaskTracker().resolveAgent('unknown')).toBeNull();
  });

  it('resolves only once, so a resumed agent re-notifies but a replayed one does not', () => {
    // The CLI re-emits `task_started` for an agent it wakes with the
    // completion of a task the agent was waiting on, and the notification
    // that follows is a real second finish. Consuming the entry keeps a
    // duplicate notification for the same finish from firing twice.
    const tracker = createBackgroundTaskTracker();
    tracker.started({ kind: 'taskStarted', taskId: 'a53f', taskType: 'local_agent', description: 'Re-review' });
    expect(tracker.resolveAgent('a53f')).toEqual({ description: 'Re-review' });
    expect(tracker.resolveAgent('a53f')).toBeNull();
    tracker.started({ kind: 'taskStarted', taskId: 'a53f', taskType: 'local_agent', description: 'Re-review' });
    expect(tracker.resolveAgent('a53f')).toEqual({ description: 'Re-review' });
  });

  it('keeps the first description when the CLI re-announces a running agent', () => {
    const tracker = createBackgroundTaskTracker();
    tracker.started({ kind: 'taskStarted', taskId: 'a53f', taskType: 'local_agent', description: 'Adversarial pre-push review' });
    tracker.started({ kind: 'taskStarted', taskId: 'a53f', taskType: 'local_agent', description: '' });
    expect(tracker.resolveAgent('a53f')).toEqual({ description: 'Adversarial pre-push review' });
  });
});
