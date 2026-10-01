/**
 * Background shells — the `local_bash` tasks (backgrounded Bash commands and
 * Monitors) the CLI is running for this session, and the tail of their output.
 *
 * Membership comes from `system:background_tasks_changed`, which carries the
 * FULL live set on every change (REPLACE semantics, per the CLI's own schema)
 * rather than start/stop edges, so a missed bookend cannot strand a row as
 * running. A shell that drops out of the set has ended; it stays listed as
 * `ended` so its last output can still be read until the user clears it.
 *
 * The snapshot is stream-only: a reloaded session has none, so no stale rows.
 *
 * Output is read on demand with the `get_task_output` control request (CLI
 * 2.1.287+): the last 8 KiB the command wrote, escape sequences included.
 */

import type { JsonlNode, BackgroundTaskEntry } from '@/types/jsonl';

export type BackgroundShellStatus = 'running' | 'ended';

export interface BackgroundShell {
  taskId: string;
  description: string;
  status: BackgroundShellStatus;
}

/** `get_task_output`'s reply, camelCased by the main process. */
export interface TaskOutputTail {
  output: string;
  /** Size of the whole output in bytes; null when the CLI omitted it. */
  totalBytes: number | null;
  /** True when `output` is only the end of a longer output. */
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

// CSI (colour, cursor, erase) and OSC (title, hyperlink) sequences.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/**
 * Terminal output as plain text: escape sequences dropped, and each line
 * reduced to its last carriage-return frame, so a progress bar reads as its
 * final state rather than every redraw run together.
 */
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
