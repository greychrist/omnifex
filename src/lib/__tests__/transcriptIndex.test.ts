import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { transcriptIndex } from '@/lib/transcriptIndex';
import { classifyStandaloneKind } from '@/lib/messageKind';
import { detectSkillInjection } from '@/lib/skillDetection';
import { isSubagentPrompt } from '@/lib/subagentDispatch';
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

describe('transcriptIndex', () => {
  it('maps tool calls and results by id', () => {
    const msgs = fixture();
    const idx = transcriptIndex(msgs);
    expect(idx.toolUses.get('t-bash')).toEqual({ name: 'Bash', input: { command: 'ls' } });
    expect(idx.toolResults.get('t-bash')).toMatchObject({ type: 'tool_result', tool_use_id: 't-bash' });
  });

  it('is built once per array', () => {
    const msgs = fixture();
    expect(transcriptIndex(msgs)).toBe(transcriptIndex(msgs));
    expect(transcriptIndex([...msgs])).not.toBe(transcriptIndex(msgs));
  });
});

describe('index-backed helpers answer what the whole-list scans answered', () => {
  const msgs = fixture();

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
