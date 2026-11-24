import type { JsonlNode } from '@/types/jsonl';
import { forwardedParentToolUseId } from '@/lib/subagentDispatch';

export type ConversationStatus = 'idle' | 'running';

interface WithStatus { status: string }

/** Per-turn metrics need this exclusion too, or a subagent's context reads as the main thread's. */
export function isMainAssistant(
  node: JsonlNode,
): node is Extract<JsonlNode, { kind: 'assistant' }> {
  if (node.kind !== 'assistant') return false;
  const isSidechain = (node.raw as { isSidechain?: boolean }).isSidechain === true;
  // Forwarded subagent assistants carry parent_tool_use_id instead of isSidechain.
  return !isSidechain && forwardedParentToolUseId(node.raw) === null;
}

/** Forwarded subagent user prompts must not anchor main-turn derivations. */
function isMainUserNode(node: JsonlNode): boolean {
  return node.kind === 'user' && forwardedParentToolUseId(node.raw) === null;
}

function isResultNode(node: JsonlNode): boolean {
  // Not a turn-closer (the session owns the turn); it only brackets a turn's content.
  return node.kind === 'cli-stream-result';
}

// In flight only: counting pending tasks or failed/inferred subagents left reloaded sessions 'running' forever.
export function hasOpenTasks(tasks: WithStatus[]): boolean {
  return tasks.some((t) => t.status === 'in_progress');
}

export function hasOpenSubagents(subagents: WithStatus[]): boolean {
  return subagents.some((s) => s.status === 'running');
}

// The turn is never inferred from the transcript: a resumed transcript ends open while the process is idle.
export function conversationStatus(
  turnRunning: boolean,
  tasks: WithStatus[],
  subagents: WithStatus[],
): 'running' | 'idle' {
  return turnRunning || hasOpenTasks(tasks) || hasOpenSubagents(subagents)
    ? 'running'
    : 'idle';
}

export function turnDuration(messages: readonly JsonlNode[], assistant: JsonlNode): number | null {
  if (assistant.kind !== 'assistant') return null;
  const prompt = turnPrompts(messages).get(assistant);
  if (!prompt) return null;
  const start = Date.parse((prompt as { raw: { timestamp?: string } }).raw.timestamp ?? '');
  const end = Date.parse((assistant.raw as { timestamp?: string }).timestamp ?? '');
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function turnPrompts(messages: readonly JsonlNode[]): Map<JsonlNode, JsonlNode> {
  let prompts = turnPromptCache.get(messages);
  if (!prompts) {
    prompts = new Map();
    let prompt: JsonlNode | undefined;
    for (const node of messages) {
      if (node.kind === 'user' && node.userKind === 'prompt' && isMainUserNode(node)) prompt = node;
      else if (node.kind === 'assistant' && prompt) prompts.set(node, prompt);
    }
    turnPromptCache.set(messages, prompts);
  }
  return prompts;
}

const turnPromptCache = new WeakMap<readonly JsonlNode[], Map<JsonlNode, JsonlNode>>();

export function sessionStartedAt(messages: JsonlNode[]): string | null {
  const first = messages[0];
  if (!first) return null;
  const ts = (first as { receivedAt?: string }).receivedAt
    ?? (first as { raw?: { timestamp?: string } }).raw?.timestamp;
  return typeof ts === 'string' ? ts : null;
}

// Skips sidechain assistants (may run another model) and `<synthetic>` (CLI-made error messages).
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

/**
 * The CLI's reply to a typed `/model`: "Set model to `fable (claude-fable-5-1)`" or "Kept model as `…`",
 * plus " and saved as your default for new sessions" when it rewrote settings.json.
 */
export function slashModelResult(node: JsonlNode): { model: string; savedAsDefault: boolean } | null {
  const text = localCommandText(node);
  if (text === null) return null;
  const m = /^\s*(?:Set model to|Kept model as) `([^`]+)`(.*)$/s.exec(text);
  if (!m) return null;
  const token = m[1].trim();
  const concrete = /\(([^()]+)\)\s*$/.exec(token)?.[1].trim();
  return {
    model: concrete && concrete.length > 0 ? concrete : token,
    savedAsDefault: m[2].includes('and saved as your default for new sessions'),
  };
}

function localCommandText(node: JsonlNode): string | null {
  let content: unknown;
  if (node.kind === 'user') content = (node.raw as { message?: { content?: unknown } }).message?.content;
  else if (node.kind === 'system' && node.subtype === 'local_command') content = (node.raw as { content?: unknown }).content;
  else return null;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((b) => {
        const block = b as { type?: unknown; text?: unknown } | null;
        return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
      }).join('')
      : null;
  if (text === null) return null;
  const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text);
  return out ? out[1] : null;
}

/** A `/model` with no turn after it counts, or a restart undoes the switch. */
export function lastSessionModel(messages: JsonlNode[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const node = messages[i];
    if (node.kind === 'assistant' && isMainAssistant(node)) {
      const model = (node.raw as { message?: { model?: unknown } }).message?.model;
      if (typeof model === 'string' && model.length > 0 && model !== '<synthetic>') return model;
      continue;
    }
    const slash = slashModelResult(node);
    if (slash) return slash.model;
  }
  return null;
}

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
 * Epoch-SECONDS reset time while parked on a usage limit; with autoContinueAtUsageLimit the turn is still running.
 * A rejection without `resetsAt` returns null: the CLI only auto-waits when it is finite.
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
      if (!isMainAssistant(n)) continue;
      return null;
    }
    if (n.kind === 'user') {
      if (!isMainUserNode(n)) continue;
      return null;
    }
  }
  return null;
}

export interface SessionAuthFailure {
  at: string;
  text: string;
}

// A failed `/recap` leaves only this stdout text, no structured marker.
const AUTH_FAILURE_STDOUT = /\bNot logged in\b|\bFailed to authenticate\b|\bOAuth session expired\b/;

function assistantText(raw: { message?: { content?: unknown } }): string {
  const content = raw.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: { type?: string; text?: string }) => (b?.type === 'text' ? b.text ?? '' : ''))
    .join('')
    .trim();
}

/**
 * A CLI whose OAuth refresh fails stays signed out until restarted, while `.claude.json` looks fine; only the
 * transcript shows it. A resumed transcript still ends on the failure, so callers discard one older than the process.
 */
export function sessionAuthFailure(messages: JsonlNode[]): SessionAuthFailure | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const n = messages[i];
    if (n.kind === 'assistant') {
      if (!isMainAssistant(n)) continue;
      const raw = n.raw as { error?: unknown; message?: { content?: unknown } };
      if (raw.error !== 'authentication_failed') return null;
      return { at: n.receivedAt, text: assistantText(raw) };
    }
    if (n.kind === 'system' && n.subtype === 'local_command') {
      const raw = n.raw as { content?: unknown; commandOutcome?: { kind?: unknown } };
      if (raw.commandOutcome?.kind !== 'failed' || typeof raw.content !== 'string') continue;
      const text = raw.content.replace(/<\/?local-command-std(?:out|err)>/g, '').trim();
      if (AUTH_FAILURE_STDOUT.test(text)) return { at: n.receivedAt, text };
    }
  }
  return null;
}
