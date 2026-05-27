import type { JsonlNode } from '@/types/jsonl';
import type { SessionStatus } from '@/lib/api';
import type { ConversationStatus } from '@/lib/sessionDerivedState';

/**
 * Node kinds that don't represent conversational progress.
 * Skipped when looking for the most recent "turn-bracket" message:
 *   - `system` covers init, notifications, hook lifecycle (hook_started /
 *     hook_progress / hook_response / user_prompt_submit), compact_boundary,
 *     turn_duration, etc. — SessionStart hooks emit hook events BEFORE any
 *     user turn, so treating those as "still waiting on Claude" pins the
 *     conversation to 'running' on a fresh idle session.
 *   - `stream-event` is the per-token partial delta; the parent `assistant`
 *     message carries the conversational signal.
 *   - overlay kinds (`stream-event`, `rate-limit`, `lifecycle`) never enter
 *     messages[] but are listed for completeness.
 */
const PLUMBING_KINDS: ReadonlySet<string> = new Set(['system', 'stream-event', 'rate-limit', 'lifecycle']);

/**
 * True when the transcript's last conversational entry is an "execution
 * complete" message — i.e. a SDK/CLI `result` row (success or error). Both
 * variants count because both terminate the turn; "execution failed" is still
 * execution over. Plumbing events (system, stream_event) are skipped when
 * locating the last entry — they trail real turns and also fire on
 * SessionStart, neither of which should mark the conversation in flight.
 * An empty transcript (or one that's only plumbing) counts as complete:
 * nothing to wait on.
 */
export function isLastMessageExecutionComplete(
  messages: JsonlNode[],
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (PLUMBING_KINDS.has(msg.kind)) continue;
    // result messages arrive as kind:'unknown' with raw.type==='result'
    if (msg.kind === 'unknown') {
      return (msg.raw as { type?: string }).type === 'result';
    }
    return false;
  }
  return true;
}

/**
 * True when we're still waiting on Claude — i.e. the transcript ends in
 * something other than an execution-complete row. Surfaced in the
 * Session Inspector as "Waiting on Claude" and one of the three inputs
 * to `deriveConversationStatus`.
 */
export function deriveWaitingOnClaude(
  messages: JsonlNode[],
): boolean {
  return !isLastMessageExecutionComplete(messages);
}

export interface DeriveConversationStatusArgs {
  sessionStatus: SessionStatus;
  messages: JsonlNode[];
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
