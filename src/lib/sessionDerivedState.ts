import type { JsonlNode } from '@/types/jsonl';

const TERMINAL_STOP_REASONS = new Set([
  'end_turn',
  'stop_sequence',
  'max_tokens',
  'refusal',
  'model_context_window_exceeded',
]);

// Treat the value of TaskRow / SubagentRow loosely — we only read `.status`.
// If/when the repo's canonical types are typed strictly, swap these aliases.
type WithStatus = { status: string };

function isMainAssistant(node: JsonlNode): boolean {
  if (node.kind !== 'assistant') return false;
  const isSidechain = (node.raw as { isSidechain?: boolean }).isSidechain === true;
  return !isSidechain;
}

function lastMainAssistant(messages: JsonlNode[]): Extract<JsonlNode, { kind: 'assistant' }> | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const n = messages[i];
    if (isMainAssistant(n)) return n as Extract<JsonlNode, { kind: 'assistant' }>;
  }
  return null;
}

function lastMainPromptIndex(messages: JsonlNode[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const n = messages[i];
    if (n.kind === 'user' && n.userKind === 'prompt') return i;
  }
  return -1;
}

// True iff the conversation is "expecting more from Claude":
//   - no assistant has appeared since the most recent user prompt, OR
//   - the last assistant in the array has a null/missing stop_reason.
// Walks messages[] from the end; filters out isSidechain=true entries
// so a streaming subagent doesn't keep the main conversation 'running'.
export function waitingOnClaude(messages: JsonlNode[]): boolean {
  if (messages.length === 0) return false;
  const lastAssistant = lastMainAssistant(messages);
  if (!lastAssistant) {
    // No main-chain assistant has spoken; we're waiting only if a prompt is awaiting reply.
    return lastMainPromptIndex(messages) >= 0;
  }
  const stop = (lastAssistant.raw as { message?: { stop_reason?: string | null } }).message?.stop_reason ?? null;
  if (stop === null) return true;
  return !TERMINAL_STOP_REASONS.has(stop);
}

export function hasOpenTasks(tasks: WithStatus[]): boolean {
  return tasks.some((t) => t.status !== 'completed');
}

export function hasOpenSubagents(subagents: WithStatus[]): boolean {
  return subagents.some((s) => s.status !== 'completed');
}

// 'waiting_permission' from the old FSM collapses into 'running':
// while a permission request is open, the corresponding task/subagent
// entry keeps hasOpenTasks / hasOpenSubagents true.
export function conversationStatus(
  messages: JsonlNode[],
  tasks: WithStatus[],
  subagents: WithStatus[],
): 'running' | 'idle' {
  return waitingOnClaude(messages) || hasOpenTasks(tasks) || hasOpenSubagents(subagents)
    ? 'running'
    : 'idle';
}

// Duration in ms between the assistant at `assistantIndex` and the
// nearest preceding user.prompt (by raw.timestamp). Returns null if
// the assistant has no preceding prompt in the array (e.g. resumed
// session where the prompt was in an earlier batch).
export function turnDuration(messages: JsonlNode[], assistantIndex: number): number | null {
  const node = messages[assistantIndex];
  if (!node || node.kind !== 'assistant') return null;
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate.kind === 'user' && candidate.userKind === 'prompt') {
      const start = Date.parse((candidate.raw as { timestamp?: string }).timestamp ?? '');
      const end = Date.parse((node.raw as { timestamp?: string }).timestamp ?? '');
      if (Number.isFinite(start) && Number.isFinite(end)) return Math.max(0, end - start);
      return null;
    }
  }
  return null;
}

export function sessionStartedAt(messages: JsonlNode[]): string | null {
  const first = messages[0];
  if (!first) return null;
  const ts = (first as { receivedAt?: string }).receivedAt
    ?? (first as { raw?: { timestamp?: string } }).raw?.timestamp;
  return typeof ts === 'string' ? ts : null;
}
