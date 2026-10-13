import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { transcriptIndex } from '@/lib/transcriptIndex';
import { createRowLookupCache, rowLookups } from '@/lib/rowLookups';
import { classifyStandaloneKind } from '@/lib/messageKind';
import { detectSkillInjection } from '@/lib/skillDetection';
import { isSubagentPrompt } from '@/lib/subagentDispatch';
import { findToolUse, hasLiveDenial } from '@/lib/permissionDenial';
import { turnDuration } from '@/lib/sessionDerivedState';

const ts = (i: number) => new Date(Date.UTC(2026, 9, 13, 0, 0, i)).toISOString();

const prompt = (i: number, extra: Record<string, unknown> = {}): JsonlNode => ({
  kind: 'user',
  userKind: 'prompt',
  sessionId: 's',
  receivedAt: ts(i),
  raw: { type: 'user', timestamp: ts(i), message: { role: 'user', content: [{ type: 'text', text: `p${i}` }] }, ...extra } as never,
});

const assistant = (i: number, content: unknown[], extra: Record<string, unknown> = {}): JsonlNode => ({
  kind: 'assistant',
  sessionId: 's',
  receivedAt: ts(i),
  raw: { type: 'assistant', timestamp: ts(i), message: { role: 'assistant', content, stop_reason: 'end_turn' }, ...extra } as never,
});

const result = (i: number, toolUseId: string, extra: Record<string, unknown> = {}, isError = false): JsonlNode => ({
  kind: 'user',
  userKind: 'tool-result',
  sessionId: 's',
  receivedAt: ts(i),
  raw: {
    type: 'user',
    timestamp: ts(i),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `out ${toolUseId}`, is_error: isError }] },
    ...extra,
  } as never,
});

const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use', id, name, input });

const denial = (i: number, toolUseId: string): JsonlNode => ({
  kind: 'system',
  subtype: 'permission_denied',
  sessionId: 's',
  receivedAt: ts(i),
  raw: { type: 'system', subtype: 'permission_denied', tool_use_id: toolUseId, tool_name: 'Bash' } as never,
});

const queueOp = (i: number, operation: string, content = 'x'): JsonlNode => ({
  kind: 'queue-operation',
  sessionId: 's',
  receivedAt: ts(i),
  raw: { type: 'queue-operation', operation, content, timestamp: ts(i) } as never,
});

/** A transcript touching every whole-list lookup a row makes. */
function fixture(): JsonlNode[] {
  return [
    prompt(0),
    assistant(1, [{ type: 'text', text: 'hi' }, toolUse('t-bash', 'Bash', { command: 'ls' })]),
    result(2, 't-bash', { toolUseResult: { stdout: 'a', gitOperation: { kind: 'commit' } } }),
    assistant(3, [toolUse('t-ask', 'AskUserQuestion', { questions: [] })]),
    result(4, 't-ask'),
    assistant(5, [toolUse('t-skill', 'Skill', { skill: 'commit' })]),
    { ...prompt(6, { sourceToolUseID: 't-skill', isMeta: true }) },
    assistant(7, [toolUse('t-agent', 'Agent', { description: 'look', prompt: 'go' })]),
    prompt(8, { parent_tool_use_id: 't-agent' }),
    assistant(9, [toolUse('t-denied', 'Bash', { command: 'rm' })]),
    denial(10, 't-denied'),
    result(11, 't-denied', {}, true),
    assistant(12, [toolUse('t-read', 'Read', { file_path: '/a.ts' })]),
    result(13, 't-read'),
    queueOp(14, 'enqueue'),
    queueOp(16, 'dequeue'),
    prompt(17),
    assistant(20, [{ type: 'text', text: 'done' }]),
  ];
}

// ── The whole-list scans these lookups replaced, verbatim in behaviour ─────
function naiveFindToolUse(nodes: readonly JsonlNode[], id: string) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.kind !== 'assistant') continue;
    for (const b of (n.raw.message?.content ?? []) as Array<{ type?: string; id?: string; name?: string; input?: unknown }>) {
      if (b?.type === 'tool_use' && b.id === id) return { name: b.name ?? 'tool', input: (b.input ?? {}) as Record<string, unknown> };
    }
  }
  return null;
}
function naiveHasLiveDenial(nodes: readonly JsonlNode[], id: string) {
  return nodes.some((n) => n.kind === 'system' && n.subtype === 'permission_denied' && (n.raw as { tool_use_id?: string }).tool_use_id === id);
}

describe('transcriptIndex', () => {
  it('maps tool calls, results, structured results and live denials by id', () => {
    const msgs = fixture();
    const idx = transcriptIndex(msgs);
    expect(idx.toolUses.get('t-bash')).toEqual({ name: 'Bash', input: { command: 'ls' } });
    expect(idx.toolResults.get('t-bash')).toMatchObject({ type: 'tool_result', tool_use_id: 't-bash' });
    expect(idx.structuredResults.get('t-bash')).toMatchObject({ gitOperation: { kind: 'commit' } });
    expect(idx.liveDenials.has('t-denied')).toBe(true);
    expect(idx.liveDenials.has('t-bash')).toBe(false);
  });

  it('is built once per array', () => {
    const msgs = fixture();
    expect(transcriptIndex(msgs)).toBe(transcriptIndex(msgs));
    expect(transcriptIndex([...msgs])).not.toBe(transcriptIndex(msgs));
  });
});

describe('index-backed helpers answer what the whole-list scans answered', () => {
  const msgs = fixture();
  const ids = ['t-bash', 't-ask', 't-skill', 't-agent', 't-denied', 't-read', 'missing'];

  it('findToolUse / hasLiveDenial', () => {
    for (const id of ids) {
      expect(findToolUse(msgs, id)).toEqual(naiveFindToolUse(msgs, id));
      expect(hasLiveDenial(msgs, id)).toBe(naiveHasLiveDenial(msgs, id));
    }
  });

  it('classifies the answered AskUserQuestion pair, skill bodies and subagent prompts', () => {
    expect(classifyStandaloneKind(msgs[3], msgs)).toBe('tool.askUserQuestion.answered');
    expect(classifyStandaloneKind(msgs[4], msgs)).toBe('tool.askUserQuestion.answered.result');
    expect(detectSkillInjection(msgs[6], msgs)).toEqual({ skillName: 'commit' });
    expect(isSubagentPrompt(msgs[8], msgs)).toBe(true);
    // The question is unanswered until its result is in the list.
    expect(classifyStandaloneKind(msgs[3], msgs.slice(0, 4))).not.toBe('tool.askUserQuestion.answered');
  });

  it('turnDuration measures from the turn-opening prompt', () => {
    expect(turnDuration(msgs, msgs[msgs.length - 1])).toBe(3000);
    expect(turnDuration(msgs, msgs[1])).toBe(1000);
    expect(turnDuration(msgs, msgs[0])).toBeNull();
    expect(turnDuration([msgs[1]], msgs[1])).toBeNull();
  });
});

describe('rowLookups', () => {
  it('carries only the facts its own row reads', () => {
    const msgs = fixture();
    const cache = createRowLookupCache();
    const bashCall = rowLookups(msgs[1], msgs, cache);
    expect([...bashCall.toolResults.keys()]).toEqual(['t-bash']);
    expect(bashCall.structuredResults.get('t-bash')).toMatchObject({ stdout: 'a' });

    const deniedResult = rowLookups(msgs[11], msgs, cache);
    expect(deniedResult.toolUses.get('t-denied')).toEqual({ name: 'Bash', input: { command: 'rm' } });
    expect(deniedResult.liveDenials.has('t-denied')).toBe(true);

    expect(rowLookups(msgs[6], msgs, cache).skillInjection).toEqual({ skillName: 'commit' });
    expect(rowLookups(msgs[15], msgs, cache).queueWaitMs).toBe(2000);
    expect(rowLookups(msgs[17], msgs, cache).turnDurationMs).toBe(3000);
    expect(rowLookups(msgs[3], msgs, cache).standaloneKind).toBe('tool.askUserQuestion.answered');
  });

  it('returns the same object when an appended record changes nothing the row reads', () => {
    const msgs = fixture();
    const cache = createRowLookupCache();
    const firstRows = msgs.map((m) => rowLookups(m, msgs, cache));
    const grown = [...msgs, prompt(30)];
    msgs.forEach((m, i) => {
      expect(rowLookups(m, grown, cache)).toBe(firstRows[i]);
    });
  });

  it('returns a new object when a record the row depends on arrives', () => {
    const call = assistant(1, [toolUse('t-late', 'Bash', { command: 'ls' })]);
    const before = [prompt(0), call];
    const cache = createRowLookupCache();
    const pending = rowLookups(call, before, cache);
    expect(pending.toolResults.size).toBe(0);

    const after = [...before, result(2, 't-late')];
    const landed = rowLookups(call, after, cache);
    expect(landed).not.toBe(pending);
    expect(landed.toolResults.get('t-late')).toBe((after[2] as unknown as { raw: { message: { content: unknown[] } } }).raw.message.content[0]);
  });
});
