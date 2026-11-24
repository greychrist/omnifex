import { describe, it, expect } from 'vitest';
import { createBackgroundTaskTracker } from '../services/sessions/background-tasks';

describe('createBackgroundTaskTracker', () => {
  it('resolves an agent notification back to the agent that started', () => {
    // `task_notification` carries no task_type.
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
    // The CLI re-emits `task_started` for an agent it wakes.
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

  it('counts open tasks of every type until each finishes', () => {
    const tracker = createBackgroundTaskTracker();
    expect(tracker.openCount()).toBe(0);
    tracker.started({ kind: 'taskStarted', taskId: 'a53f', taskType: 'local_agent', description: 'Review' });
    tracker.started({ kind: 'taskStarted', taskId: 'bnnc', taskType: 'local_bash', description: 'Sleep' });
    tracker.started({ kind: 'taskStarted', taskId: 'a53f', taskType: 'local_agent', description: '' });
    expect(tracker.openCount()).toBe(2);
    tracker.finished('bnnc');
    tracker.finished('unknown');
    expect(tracker.openCount()).toBe(1);
    tracker.finished('a53f');
    expect(tracker.openCount()).toBe(0);
  });
});
