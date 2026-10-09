/**
 * Step progress the model reports itself, through the bundled OmniFex mod's
 * `progress` tool (`omnifex-mod/`). Nothing else in the CLI says how far
 * through its work an agent is; see
 * docs/superpowers/specs/2026-10-09-agent-step-progress-design.md.
 *
 * The tool's answer is a no-op — what matters is the call. A subagent's call
 * arrives as a tool_use block in its forwarded frames (keyed by the
 * dispatching `parent_tool_use_id`, plus `agent_id` on CLI >= 2.1.292); the
 * main session's arrives in the main stream like any tool_use. Forwarded
 * frames are not persisted, so after a reload a running agent shows its state
 * bar until it next reports.
 */
import type { JsonlNode } from '@/types/jsonl';
import { forwardedParentToolUseId } from './subagentDispatch';
import { forwardedAgentId } from './subagentEvents';
import type { Subagent } from './subagentStreams';

export const PROGRESS_TOOL = 'mcp__omnifex__progress';

export interface StepProgress {
  done: number;
  total: number;
  note?: string;
}

export interface SubagentProgressIndex {
  byToolUseId: Record<string, StepProgress>;
  byAgentId: Record<string, StepProgress>;
}

/**
 * The tool's input, or null when it cannot draw a bar. `total` is the model's
 * estimate and must be a positive number; `done` is clamped into range, since
 * a model that overshoots its own estimate has still finished.
 */
export function parseProgressInput(input: unknown): StepProgress | null {
  if (!input || typeof input !== 'object') return null;
  const { done, total, note } = input as Record<string, unknown>;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;
  const d = typeof done === 'number' && Number.isFinite(done) ? done : 0;
  const trimmed = typeof note === 'string' ? note.trim() : '';
  return {
    done: Math.min(Math.max(d, 0), total),
    total,
    ...(trimmed ? { note: trimmed } : {}),
  };
}

/** Every valid progress call an assistant message carries, in order. */
function progressCalls(m: JsonlNode): StepProgress[] {
  if (m.kind !== 'assistant') return [];
  const content = (m.raw as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const out: StepProgress[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; name?: unknown; input?: unknown };
    if (b?.type !== 'tool_use' || b.name !== PROGRESS_TOOL) continue;
    const p = parseProgressInput(b.input);
    if (p) out.push(p);
  }
  return out;
}

/** Each subagent's latest report, last call wins. */
export function latestSubagentProgress(messages: JsonlNode[]): SubagentProgressIndex {
  const byToolUseId: Record<string, StepProgress> = {};
  const byAgentId: Record<string, StepProgress> = {};
  for (const m of messages) {
    if (m.kind !== 'assistant') continue;
    const raw = m.raw as unknown as Record<string, unknown>;
    const parent = forwardedParentToolUseId(raw);
    if (!parent) continue;
    const calls = progressCalls(m);
    if (calls.length === 0) continue;
    const last = calls[calls.length - 1]!;
    byToolUseId[parent] = last;
    const agentId = forwardedAgentId(raw);
    if (agentId) byAgentId[agentId] = last;
  }
  return { byToolUseId, byAgentId };
}

/** The main session's latest report in the current turn: after the last real prompt. */
export function latestMainProgress(messages: JsonlNode[]): StepProgress | null {
  let latest: StepProgress | null = null;
  for (const m of messages) {
    if (m.kind === 'user' && m.userKind === 'prompt') {
      latest = null;
      continue;
    }
    if (m.kind !== 'assistant') continue;
    if (forwardedParentToolUseId(m.raw as unknown as Record<string, unknown>)) continue;
    const calls = progressCalls(m);
    if (calls.length > 0) latest = calls[calls.length - 1]!;
  }
  return latest;
}

/**
 * Attach each row's latest report: by its dispatch, else — for a nested row,
 * whose dispatch the main stream never saw — by its agent id. Returns the
 * input array itself when no row reported.
 */
export function withStepProgress(subs: Subagent[], index: SubagentProgressIndex): Subagent[] {
  let changed = false;
  const out = subs.map((s) => {
    const p = index.byToolUseId[s.toolUseId] ?? (s.taskId ? index.byAgentId[s.taskId] : undefined);
    if (!p) return s;
    changed = true;
    return { ...s, stepProgress: p };
  });
  return changed ? out : subs;
}
