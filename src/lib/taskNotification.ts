import { tagText, tagInt } from './xmlTags';

/**
 * A `<task-notification>` the CLI injected into the transcript when a
 * backgrounded task reported in — a background command finishing, an agent
 * stopping, a Monitor firing.
 *
 * Everything is optional because the producers disagree about which tags they
 * write: across this account's transcripts, `summary` appears on all of them,
 * `status` and `output-file` on most, `result`/`usage` only on agent runs, and
 * `event` only on Monitor firings.
 */
export interface TaskNotification {
  summary?: string;
  status?: 'completed' | 'failed';
  taskId?: string;
  toolUseId?: string;
  outputFile?: string;
  /** An agent's returned text. */
  result?: string;
  /** A Monitor's firing text. */
  event?: string;
  usage?: { tokens?: number; toolUses?: number; durationMs?: number };
}

export function parseTaskNotification(text: string): TaskNotification | null {
  if (!text.includes('<task-notification>')) return null;

  const usageBlock = tagText(text, 'usage');
  const usage = usageBlock
    ? {
        // `subagent_tokens`, not `total_tokens` — the XML block spells these
        // differently from the structured `task_notification` usage object.
        tokens: tagInt(usageBlock, 'subagent_tokens'),
        toolUses: tagInt(usageBlock, 'tool_uses'),
        durationMs: tagInt(usageBlock, 'duration_ms'),
      }
    : undefined;

  const statusRaw = tagText(text, 'status');

  // `note` is deliberately not read: it is the same boilerplate paragraph on
  // every agent notification, explaining the notification's own semantics
  // rather than anything about this run. The raw-payload viewer on the card
  // still shows it.
  return {
    summary: tagText(text, 'summary'),
    status: statusRaw === undefined ? undefined : statusRaw === 'completed' ? 'completed' : 'failed',
    taskId: tagText(text, 'task-id'),
    toolUseId: tagText(text, 'tool-use-id'),
    outputFile: tagText(text, 'output-file'),
    result: tagText(text, 'result'),
    event: tagText(text, 'event'),
    usage,
  };
}
