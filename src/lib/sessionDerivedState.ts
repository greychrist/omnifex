import type { JsonlNode } from '@/types/jsonl';
import { forwardedParentToolUseId } from '@/lib/subagentDispatch';

/**
 * Conversation rollup: the session's own turn axis (mirrored from main, see
 * docs/session-lifecycle.md) OR'd with the transcript-derived task / subagent
 * rows. 'waiting_permission' from the old FSM is collapsed into 'running'
 * (the permission card is still present in JSONL as an open task entry while
 * it is pending).
 */
export type ConversationStatus = 'idle' | 'running';

// Treat the value of TaskRow / SubagentRow loosely — we only read `.status`.
// If/when the repo's canonical types are typed strictly, swap these aliases.
type WithStatus = { status: string };

/**
 * Exported because any per-turn metric needs the same exclusion — see
 * `turnDelta.ts` and `contextTimeline.ts`, both of which would otherwise treat
 * a subagent's context window as the main thread's.
 */
export function isMainAssistant(
  node: JsonlNode,
): node is Extract<JsonlNode, { kind: 'assistant' }> {
  if (node.kind !== 'assistant') return false;
  const isSidechain = (node.raw as { isSidechain?: boolean }).isSidechain === true;
  // Live-forwarded subagent assistants (--forward-subagent-text) carry a
  // non-empty parent_tool_use_id instead of isSidechain — same exclusion:
  // they may run a different model and their stop_reason brackets the
  // subagent's own turn, not the main one.
  return !isSidechain && forwardedParentToolUseId(node.raw) === null;
}

/** Forwarded subagent user prompts must not anchor main-turn derivations. */
function isMainUserNode(node: JsonlNode): boolean {
  return node.kind === 'user' && forwardedParentToolUseId(node.raw) === null;
}

function isResultNode(node: JsonlNode): boolean {
  // The CLI's turn-complete `result` envelope (kind:'cli-stream-result' since
  // the engine-mode reclassification in jsonlClassifier). Not a turn-closer
  // here — the session owns the turn axis — but it does bracket what a
  // transcript walk may read as "this turn's" content.
  return node.kind === 'cli-stream-result';
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

// The main turn is the SESSION's axis (`turn.status === 'running'`, mirrored
// from main — see docs/session-lifecycle.md), never read off the transcript
// here. Tasks and subagents are transcript content and stay derived.
// 'waiting_permission' from the old FSM collapses into 'running': while a
// permission request is open, the corresponding task/subagent entry keeps
// hasOpenTasks / hasOpenSubagents true.
export function conversationStatus(
  turnRunning: boolean,
  tasks: WithStatus[],
  subagents: WithStatus[],
): 'running' | 'idle' {
  return turnRunning || hasOpenTasks(tasks) || hasOpenSubagents(subagents)
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
    if (candidate.kind === 'user' && candidate.userKind === 'prompt' && isMainUserNode(candidate)) {
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

// The concrete model id the session is actually running, read off the most
// recent main-chain assistant message (the CLI stamps `message.model` on every
// assistant JSONL line). Covers resumed transcripts and the window before the
// first get_context_usage fetch. Sidechain (subagent) assistants are skipped —
// they may run a different model — and so are `<synthetic>` stamps (the CLI's
// marker on synthesized error assistants). Null when no assistant has spoken.
export function lastAssistantModel(messages: JsonlNode[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const node = messages[i];
    if (node.kind !== 'assistant' || !isMainAssistant(node)) continue;
    const model = (node.raw as { message?: { model?: unknown } }).message?.model;
    if (typeof model === 'string' && model.length > 0 && model !== '<synthetic>') {
      return model;
    }
  }
  return null;
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

/**
 * Epoch-SECONDS reset time when the session is parked on a claude.ai usage
 * limit, or null when it isn't.
 *
 * Claude Code 2.1.234 added `autoContinueAtUsageLimit`, which defaults ON for
 * claude.ai logins (the CLI only defaults it off when an API key is present).
 * A limited session no longer ends its turn — it waits for the reset and then
 * continues, which can be hours. `waitingOnClaude` stays true across that wait
 * and it is right to: the CLI really is still working the turn. But nothing
 * told the user why, so the composer just spun.
 *
 * Same backward walk as `waitingOnClaude`, with one more decisive node kind:
 *
 *   - a `rate-limit-event` DECIDES. `rejected` + a numeric `resetsAt` means we
 *     are parked until then; anything else means the limit is no longer
 *     blocking and there is nothing to report.
 *   - an assistant / result / main user node means the turn has spoken since
 *     the rejection — it resumed or finished. Not waiting.
 *   - everything else is bookkeeping and is skipped, exactly as above.
 *
 * A rejection with no `resetsAt` returns null on purpose: the CLI's own
 * auto-continue predicate requires a finite `resetsAt`, and without one it
 * offers the wait as a dialog choice rather than waiting. There is no wait to
 * report, and inventing one would be a lie about what the CLI is doing.
 *
 * Deliberately takes no clock. Whether the reset time has passed is a
 * presentation question, and keeping it out of here leaves the derivation
 * pure and its tests deterministic.
 */
export function usageLimitWait(messages: JsonlNode[]): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const n = messages[i];
    if (n.kind === 'rate-limit-event') {
      const info = n.raw.rate_limit_info;
      if (info?.status !== 'rejected') return null;
      return typeof info.resetsAt === 'number' ? info.resetsAt : null;
    }
    if (isResultNode(n)) return null;
    if (n.kind === 'assistant') {
      if (!isMainAssistant(n)) continue; // sidechain subagent — not the main turn
      return null;
    }
    if (n.kind === 'user') {
      if (!isMainUserNode(n)) continue; // forwarded subagent prompt — not main-turn traffic
      return null;
    }
    // anything else is bookkeeping — keep scanning backward.
  }
  return null;
}
