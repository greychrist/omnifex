import type { RuntimeEvent } from './events';

export interface BackgroundTaskTracker {
  started: (ev: Extract<RuntimeEvent, { kind: 'taskStarted' }>) => void;
  // Consumes the entry: the CLI re-emits `task_started` for each wake, and each wake ends in its own notification.
  resolveAgent: (taskId: string) => { description: string } | null;
  finished: (taskId: string) => void;
  openCount: () => number;
}

export function createBackgroundTaskTracker(): BackgroundTaskTracker {
  const agents = new Map<string, { description: string }>();
  const open = new Set<string>();

  return {
    started(ev) {
      if (ev.taskId) open.add(ev.taskId);
      if (ev.taskType !== 'local_agent' || !ev.taskId) return;
      const existing = agents.get(ev.taskId);
      // A wake re-announces with an empty description; keep the launch label.
      if (existing && !ev.description) return;
      agents.set(ev.taskId, { description: ev.description || existing?.description || '' });
    },
    resolveAgent(taskId) {
      const hit = agents.get(taskId);
      if (!hit) return null;
      agents.delete(taskId);
      return hit;
    },
    finished(taskId) {
      open.delete(taskId);
    },
    openCount() {
      return open.size;
    },
  };
}
