import { describe, it, expect } from 'vitest';
import { classifyBlockKind, isBlockHiddenInCompact } from '../blockKind';
import { createDefaultConfig } from '../messageRenderingConfig';
import type { ClaudeStreamMessage } from '@/types/claudeStream';

const assistant = (content: any[]): ClaudeStreamMessage =>
  ({ type: 'assistant', message: { content } }) as any;

const user = (content: any[]): ClaudeStreamMessage =>
  ({ type: 'user', message: { content } }) as any;

describe('classifyBlockKind', () => {
  it('classifies assistant text blocks', () => {
    const parent = assistant([{ type: 'text', text: 'hello' }]);
    expect(classifyBlockKind(parent.message!.content![0], parent)).toBe('assistant.text');
  });

  it('returns null for empty assistant text', () => {
    const parent = assistant([{ type: 'text', text: '   ' }]);
    expect(classifyBlockKind(parent.message!.content![0], parent)).toBeNull();
  });

  it('classifies assistant thinking blocks with content', () => {
    const parent = assistant([{ type: 'thinking', thinking: 'reasoning…' }]);
    expect(classifyBlockKind(parent.message!.content![0], parent)).toBe('assistant.thinking');
  });

  it('returns null for signature-only thinking blocks', () => {
    const parent = assistant([{ type: 'thinking', thinking: '', signature: 'sig' }]);
    expect(classifyBlockKind(parent.message!.content![0], parent)).toBeNull();
  });

  it('classifies assistant tool_use blocks for known tool names', () => {
    const parent = assistant([{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }]);
    expect(classifyBlockKind(parent.message!.content![0], parent)).toBe('assistant.toolUse');
  });

  it('classifies assistant tool_use blocks for an unknown tool name as assistant.toolUse.unknown', () => {
    const parent = assistant([{ type: 'tool_use', name: 'SomeRandomTool', input: {} }]);
    expect(classifyBlockKind(parent.message!.content![0], parent)).toBe('assistant.toolUse.unknown');
  });

  it('classifies tool_use as known when the name is case-mismatched with the registry', () => {
    // The renderer matches case-insensitively (e.g. "BASH" still maps to BashWidget),
    // so the classifier should agree.
    const parent = assistant([{ type: 'tool_use', name: 'BASH', input: { command: 'ls' } }]);
    expect(classifyBlockKind(parent.message!.content![0], parent)).toBe('assistant.toolUse');
  });

  it('classifies subagent dispatch tool_use (Task / Agent) as known', () => {
    const parent1 = assistant([{ type: 'tool_use', name: 'Task', input: { description: 'x' } }]);
    expect(classifyBlockKind(parent1.message!.content![0], parent1)).toBe('assistant.toolUse');
    const parent2 = assistant([{ type: 'tool_use', name: 'Agent', input: { description: 'x' } }]);
    expect(classifyBlockKind(parent2.message!.content![0], parent2)).toBe('assistant.toolUse');
  });

  it('classifies any mcp__* tool_use as known', () => {
    const parent = assistant([{ type: 'tool_use', name: 'mcp__foo__bar', input: {} }]);
    expect(classifyBlockKind(parent.message!.content![0], parent)).toBe('assistant.toolUse');
  });

  it('classifies user image blocks', () => {
    const parent = user([{ type: 'image', source: { type: 'base64', data: '...' } }]);
    expect(classifyBlockKind(parent.message!.content![0], parent)).toBe('user.image');
  });

  it('classifies user tool_result with system-reminder as systemReminder', () => {
    const parent = user([
      { type: 'tool_result', content: 'output\n<system-reminder>note</system-reminder>' },
    ]);
    expect(classifyBlockKind(parent.message!.content![0], parent)).toBe('tool.result.systemReminder');
  });

  it('classifies plain user tool_result as generic', () => {
    const parent = user([{ type: 'tool_result', content: 'plain output' }]);
    expect(classifyBlockKind(parent.message!.content![0], parent)).toBe('tool.result.generic');
  });

  it('classifies user text containing system-reminder as systemContext', () => {
    const parent = user([{ type: 'text', text: 'hello\n<system-reminder>x</system-reminder>' }]);
    expect(classifyBlockKind(parent.message!.content![0], parent)).toBe('user.systemContext');
  });

  it('returns null for plain user typed text (handled by whole-message classification)', () => {
    const parent = user([{ type: 'text', text: 'just a normal prompt' }]);
    expect(classifyBlockKind(parent.message!.content![0], parent)).toBeNull();
  });

  it('returns null for unknown block types', () => {
    const parent = assistant([{ type: 'mystery' }]);
    expect(classifyBlockKind(parent.message!.content![0], parent)).toBeNull();
  });

  it('returns null for null/undefined block', () => {
    const parent = assistant([]);
    expect(classifyBlockKind(null, parent)).toBeNull();
    expect(classifyBlockKind(undefined, parent)).toBeNull();
  });
});

describe('isBlockHiddenInCompact', () => {
  it('hides assistant.toolUse by default', () => {
    const config = createDefaultConfig();
    const parent = assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]);
    expect(isBlockHiddenInCompact(parent.message!.content![0], parent, config)).toBe(true);
  });

  it('shows assistant.text by default', () => {
    const config = createDefaultConfig();
    const parent = assistant([{ type: 'text', text: 'reply' }]);
    expect(isBlockHiddenInCompact(parent.message!.content![0], parent, config)).toBe(false);
  });

  it('hides tool_result.generic by default', () => {
    const config = createDefaultConfig();
    const parent = user([{ type: 'tool_result', content: 'output' }]);
    expect(isBlockHiddenInCompact(parent.message!.content![0], parent, config)).toBe(true);
  });

  it('respects user override that unhides assistant.thinking', () => {
    const config = createDefaultConfig();
    config.kinds['assistant.thinking'].hiddenInCompact = false;
    const parent = assistant([{ type: 'thinking', thinking: 'deep' }]);
    expect(isBlockHiddenInCompact(parent.message!.content![0], parent, config)).toBe(false);
  });

  it('returns false for unclassified blocks', () => {
    const config = createDefaultConfig();
    const parent = user([{ type: 'text', text: 'plain typed prompt' }]);
    expect(isBlockHiddenInCompact(parent.message!.content![0], parent, config)).toBe(false);
  });
});
