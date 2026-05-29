import type { JsonlNode } from '@/types/jsonl';

/**
 * Turn axis of the session — derived by the renderer from JSONL content +
 * task/subagent stores. 'waiting_permission' from the old FSM is collapsed
 * into 'running' (the permission card is still present in JSONL as an open
 * task entry while it is pending).
 *
 * This type lives in sessionDerivedState.ts (not api.ts) because the main
 * process no longer produces or tracks it — it is renderer-only state.
 */
export type ConversationStatus = 'idle' | 'running';

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

function isResultNode(node: JsonlNode): boolean {
  // The CLI's turn-complete `result` envelope. Since the engine-mode
  // reclassification (jsonlClassifier) it arrives as kind:'cli-stream-result';
  // older/persisted transcripts never carried result rows at all, so there is
  // no legacy `unknown`+`type:'result'` shape left to honor. This row is the
  // authoritative turn-closer under --include-partial-messages, where the
  // committed assistant carries stop_reason:null (the terminal reason rides
  // the message_delta overlay, which never enters messages[]).
  return node.kind === 'cli-stream-result';
}

function lastMainPromptIndex(messages: JsonlNode[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const n = messages[i];
    if (n.kind === 'user' && n.userKind === 'prompt') return i;
  }
  return -1;
}

// True iff the conversation is "expecting more from Claude". Walks messages[]
// from the end; only THREE kinds of node have the power to decide the turn
// axis, and the first one encountered wins. Everything else is skipped — that
// deliberately includes bookkeeping/overlay nodes that routinely TRAIL a
// completed turn (system status/init/hooks, stream-event / rate-limit /
// lifecycle overlays, last-prompt / queue-operation / ai-title /
// file-history-snapshot / permission-mode entries, non-result `unknown`
// nodes, and sidechain subagent assistants). Skipping by default — rather than
// matching a hardcoded plumbing list — means a new bookkeeping kind can't
// silently reopen a closed turn.
//
//   - a `result` row (kind:'cli-stream-result') CLOSES the turn.
//     Under --include-partial-messages the committed assistant carries
//     stop_reason: null (the terminal reason rides the message_delta
//     stream_event, which never enters messages[]), so the result row — not
//     the assistant — is what ends a live-streamed turn.
//   - a main-chain assistant settles by stop_reason: terminal => done,
//     null/non-terminal => still going. Resumed/persisted transcripts carry
//     the real stop_reason here (and no result row), so loaded history settles
//     through this branch.
//   - a user message (prompt or tool-result) means no assistant/result has
//     spoken since: defer to the prompt-awaiting check below.
export function waitingOnClaude(messages: JsonlNode[]): boolean {
  if (messages.length === 0) return false;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const n = messages[i];
    if (isResultNode(n)) return false;
    if (n.kind === 'assistant') {
      if (!isMainAssistant(n)) continue; // sidechain subagent — doesn't bracket the main turn
      const stop = (n.raw as { message?: { stop_reason?: string | null } }).message?.stop_reason ?? null;
      if (stop === null) return true;
      return !TERMINAL_STOP_REASONS.has(stop);
    }
    if (n.kind === 'user') break; // defer to the prompt-awaiting check
    // anything else is not turn-significant — keep scanning backward.
  }

  // No assistant or result has spoken since the most recent prompt — waiting
  // only if a prompt is actually awaiting a reply (a lone tool-result is not).
  return lastMainPromptIndex(messages) >= 0;
}

// "Open" means actively in flight, not merely "not done." Pending tasks
// (planned but never started) and failed / abandoned / completed_inferred
// subagents do NOT count — otherwise a closed session that ended with
// unstarted todos or a killed subagent renders as 'running' forever on
// reload. Matches the pre-refactor FSM's "inProgress > 0" / "any running
// subagent" semantics.
export function hasOpenTasks(tasks: WithStatus[]): boolean {
  return tasks.some((t) => t.status === 'in_progress');
}

export function hasOpenSubagents(subagents: WithStatus[]): boolean {
  return subagents.some((s) => s.status === 'running');
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

// The permission mode in effect at the end of the session, for restoring a
// resumed tab to where it left off. Walks messages[] from the end and returns
// the first `permissionMode` it finds on either a dedicated `permission-mode`
// record or a `user` envelope (both carry the field). Returns null when the
// session never recorded one — the caller then falls back to the account
// default and finally the hardcoded mode.
export function lastPermissionMode(messages: JsonlNode[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const node = messages[i];
    if (node.kind === 'permission-mode' || node.kind === 'user') {
      const mode = (node.raw as { permissionMode?: unknown }).permissionMode;
      if (typeof mode === 'string' && mode.length > 0) return mode;
    }
  }
  return null;
}
