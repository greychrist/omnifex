// Sessions module — background task bookkeeping
//
// The CLI announces a background task twice: `task_started` when it begins
// and `task_notification` when it ends. Only the first carries `task_type`
// ('local_agent' | 'local_bash') and the human-readable description, and
// only the second means "tell the user". This keeps the pairing.
//
// Deliberately tiny and per-session: it holds no lifecycle state, nothing
// derives from it, and losing it costs at most one notification. Session
// status remains the renderer's job (see docs/session-lifecycle.md) — this
// is bookkeeping for a notification label, not a state axis.

import type { RuntimeEvent } from './events';

export interface BackgroundTaskTracker {
  started: (ev: Extract<RuntimeEvent, { kind: 'taskStarted' }>) => void;
  /**
   * The finishing task's description if it is an AGENT we saw start, else
   * null (a backgrounded shell, or a task from before this listener
   * attached). Consumes the entry: the CLI re-emits `task_started` for an
   * agent it wakes to deliver a child task's completion, and each wake ends
   * in its own notification, so one start pairs with exactly one notify.
   */
  resolveAgent: (taskId: string) => { description: string } | null;
}

export function createBackgroundTaskTracker(): BackgroundTaskTracker {
  const agents = new Map<string, { description: string }>();

  return {
    started(ev) {
      if (ev.taskType !== 'local_agent' || !ev.taskId) return;
      const existing = agents.get(ev.taskId);
      // A re-announcement can arrive with an empty description (the wake
      // carries the notification XML as its prompt instead) — keep the
      // label the agent was launched with.
      if (existing && !ev.description) return;
      agents.set(ev.taskId, { description: ev.description || existing?.description || '' });
    },
    resolveAgent(taskId) {
      const hit = agents.get(taskId);
      if (!hit) return null;
      agents.delete(taskId);
      return hit;
    },
  };
}
