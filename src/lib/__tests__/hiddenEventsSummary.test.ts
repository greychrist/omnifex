import { describe, it, expect } from 'vitest';
import { summarizeHiddenEvents, countHiddenEvents } from '../hiddenEventsSummary';
import type { JsonlNode } from '@/types/jsonl';

const assistant = (content: any[]): JsonlNode =>
  ({ kind: 'assistant', sessionId: '', receivedAt: '', raw: { type: 'assistant', message: { role: 'assistant', content } } }) as unknown as JsonlNode;

const user = (content: any[]): JsonlNode =>
  ({ kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '', raw: { type: 'user', message: { role: 'user', content } } }) as unknown as JsonlNode;

const system = (subtype: string, extra: Record<string, any> = {}): JsonlNode =>
  ({ kind: 'system', subtype, sessionId: '', receivedAt: '', raw: { type: 'system', subtype, ...extra } }) as unknown as JsonlNode;

describe('summarizeHiddenEvents', () => {
  it('returns empty string for empty list', () => {
    expect(summarizeHiddenEvents([])).toBe('');
  });

  it('summarizes single Read tool use', () => {
    const msgs = [assistant([{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }])];
    const summary = summarizeHiddenEvents(msgs);
    expect(summary.toLowerCase()).toMatch(/read|file/);
  });

  it('summarizes multiple file reads as a count', () => {
    const msgs = [
      assistant([
        { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
        { type: 'tool_use', name: 'Read', input: { file_path: 'b.ts' } },
        { type: 'tool_use', name: 'Read', input: { file_path: 'c.ts' } },
      ]),
    ];
    expect(summarizeHiddenEvents(msgs)).toMatch(/3 files?/i);
  });

  it('summarizes a mix of reads, edits, and bash', () => {
    const msgs = [
      assistant([
        { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
        { type: 'tool_use', name: 'Read', input: { file_path: 'b.ts' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
      ]),
    ];
    const s = summarizeHiddenEvents(msgs);
    expect(s).toMatch(/read/i);
    expect(s).toMatch(/edit/i);
    expect(s).toMatch(/command|bash|ran/i);
  });

  it('counts Grep/Glob as searches', () => {
    const msgs = [
      assistant([
        { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
        { type: 'tool_use', name: 'Glob', input: { pattern: '**/*.ts' } },
      ]),
    ];
    expect(summarizeHiddenEvents(msgs)).toMatch(/search/i);
  });

  it('counts Task as a subagent dispatch', () => {
    const msgs = [
      assistant([{ type: 'tool_use', name: 'Task', input: { description: 'Investigate' } }]),
    ];
    expect(summarizeHiddenEvents(msgs)).toMatch(/subagent/i);
  });

  it('counts non-empty thinking blocks', () => {
    const msgs = [
      assistant([
        { type: 'thinking', thinking: 'long ponder' },
        { type: 'thinking', thinking: 'another' },
      ]),
    ];
    expect(summarizeHiddenEvents(msgs)).toMatch(/thought|thinking/i);
  });

  it('ignores empty thinking blocks', () => {
    const msgs = [
      assistant([{ type: 'thinking', thinking: '', signature: 'x' }]),
    ];
    expect(summarizeHiddenEvents(msgs)).toBe('');
  });

  it('summarizes system events when nothing else is present', () => {
    const msgs = [system('init'), system('notification', { notification_type: 'info' })];
    expect(summarizeHiddenEvents(msgs)).toMatch(/system/i);
  });

  it('summarizes tool_results', () => {
    const msgs = [
      user([
        { type: 'tool_result', content: 'output a' },
        { type: 'tool_result', content: 'output b' },
      ]),
    ];
    expect(summarizeHiddenEvents(msgs)).toMatch(/result/i);
  });

  it('returns a single sentence (no run-on)', () => {
    const msgs = [
      assistant([
        ...Array.from({ length: 5 }, () => ({ type: 'tool_use', name: 'Read', input: { file_path: 'x' } })),
        ...Array.from({ length: 3 }, () => ({ type: 'tool_use', name: 'Edit', input: { file_path: 'x' } })),
        ...Array.from({ length: 2 }, () => ({ type: 'tool_use', name: 'Bash', input: { command: 'x' } })),
      ]),
    ];
    const s = summarizeHiddenEvents(msgs);
    expect(s.endsWith('.')).toBe(true);
    expect(s.split('.').length).toBeLessThanOrEqual(2); // one sentence + trailing empty
  });
});

describe('countHiddenEvents', () => {
  it('counts each renderable content block as one event', () => {
    const msgs = [
      assistant([
        { type: 'text', text: 'hi' },
        { type: 'tool_use', name: 'Read', input: { file_path: 'a' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'a' } },
      ]),
      user([{ type: 'tool_result', content: 'ok' }]),
    ];
    expect(countHiddenEvents(msgs)).toBe(4);
  });

  it('counts a system message as one event', () => {
    expect(countHiddenEvents([system('init')])).toBe(1);
  });

  it('skips empty thinking blocks', () => {
    const msgs = [assistant([{ type: 'thinking', thinking: '', signature: 'x' }])];
    expect(countHiddenEvents(msgs)).toBe(0);
  });
});
