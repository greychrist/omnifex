// `background_tasks_changed` carries the full live set (replace semantics), so a missed edge cannot strand a row as running.

import type { JsonlNode, BackgroundTaskEntry } from '@/types/jsonl';

export type BackgroundShellStatus = 'running' | 'ended';

export interface BackgroundShell {
  taskId: string;
  description: string;
  status: BackgroundShellStatus;
}

/** `get_task_output`'s reply, camelCased by the daemon. */
export interface TaskOutputTail {
  output: string;
  totalBytes: number | null;
  truncated: boolean;
}

export function deriveBackgroundShells(messages: JsonlNode[]): BackgroundShell[] {
  const seen = new Map<string, BackgroundShell>();
  for (const m of messages) {
    if (m.kind !== 'system' || m.subtype !== 'background_tasks_changed') continue;
    const tasks: BackgroundTaskEntry[] = Array.isArray(m.raw.tasks) ? m.raw.tasks : [];
    const live = new Set<string>();
    for (const t of tasks) {
      if (t.task_type !== 'local_bash' || typeof t.task_id !== 'string') continue;
      live.add(t.task_id);
      seen.set(t.task_id, {
        taskId: t.task_id,
        description: t.description ?? seen.get(t.task_id)?.description ?? '',
        status: 'running',
      });
    }
    for (const s of seen.values()) {
      if (!live.has(s.taskId)) s.status = 'ended';
    }
  }
  return [...seen.values()];
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function plainTaskOutput(raw: string): string {
  return raw
    .replace(ANSI_RE, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const frames = line.split('\r');
      return frames[frames.length - 1];
    })
    .join('\n');
}
