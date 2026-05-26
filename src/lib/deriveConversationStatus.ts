import type { ClaudeStreamMessage } from '@/types/claudeStream';
import type { SessionStatus, ConversationStatus } from '@/lib/api';

/**
 * True when the transcript's last entry is an "execution complete" message
 * — i.e. a SDK/CLI `result` row (success or error). Both variants count
 * because both terminate the turn; "execution failed" is still execution
 * over. An empty transcript counts as complete (nothing to wait on).
 */
export function isLastMessageExecutionComplete(
  messages: ClaudeStreamMessage[],
): boolean {
  if (messages.length === 0) return true;
  const last = messages[messages.length - 1] as { type?: string };
  return last.type === 'result';
}

/**
 * True when we're still waiting on Claude — i.e. the transcript ends in
 * something other than an execution-complete row. Surfaced in the
 * Session Inspector as "Waiting on Claude" and one of the three inputs
 * to `deriveConversationStatus`.
 */
export function deriveWaitingOnClaude(
  messages: ClaudeStreamMessage[],
): boolean {
  return !isLastMessageExecutionComplete(messages);
}

export interface DeriveConversationStatusArgs {
  sessionStatus: SessionStatus;
  messages: ClaudeStreamMessage[];
  /** True if any task is not yet `complete`. */
  hasIncompleteTasks: boolean;
  /** True if any subagent is not yet `complete`. */
  hasIncompleteSubagents: boolean;
}

/**
 * Compute `conversationStatus` from three signals:
 *   - waitingOnClaude (the last transcript message is not an execution-
 *     complete row),
 *   - any task with status !== 'complete',
 *   - any subagent with status !== 'complete'.
 *
 * Idle iff all three are settled. Returns null whenever there's no live
 * connection — the conversation axis is meaningless without a phone call.
 *
 * Replaces the prior event-driven model where the runtime flipped
 * `running` on every non-init/non-result message. See
 * `docs/session-lifecycle.md`.
 */
export function deriveConversationStatus({
  sessionStatus,
  messages,
  hasIncompleteTasks,
  hasIncompleteSubagents,
}: DeriveConversationStatusArgs): ConversationStatus | null {
  if (sessionStatus !== 'started') return null;
  if (deriveWaitingOnClaude(messages)) return 'running';
  if (hasIncompleteTasks || hasIncompleteSubagents) return 'running';
  return 'idle';
}
