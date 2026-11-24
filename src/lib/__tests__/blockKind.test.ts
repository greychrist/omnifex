import { describe, it, expect } from 'vitest';
import { classifyBlockKind, deriveSystemContextLabel, isSystemContextText } from '../blockKind';
import { KNOWN_TOOL_NAMES } from '../types/toolInput';
import type { JsonlNode } from '@/types/jsonl';

describe('deriveSystemContextLabel', () => {
  it('labels a skill load with its markdown heading', () => {
    const content = 'Base directory for this skill: /x/y\n\n# Brainstorming Ideas Into Designs\n\nHelp turn ideas...';
    expect(deriveSystemContextLabel(content)).toBe('Skill: Brainstorming Ideas Into Designs');
  });

  it('falls back to "Skill Loaded" for a skill load with no heading', () => {
    expect(deriveSystemContextLabel('Base directory for this skill: /x/y\n\nno heading here')).toBe('Skill Loaded');
  });

  it('labels CLAUDE.md context', () => {
    expect(deriveSystemContextLabel('Contents of CLAUDE.md (project instructions):')).toBe('CLAUDE.md Context');
  });

  it('labels a system reminder', () => {
    expect(deriveSystemContextLabel('<system-reminder>do the thing</system-reminder>')).toBe('System Reminder');
  });

  it('falls back to "System Context" for anything else', () => {
    expect(deriveSystemContextLabel('some other injected context')).toBe('System Context');
  });
});

describe('isSystemContextText — skill preamble must be anchored at the start', () => {
  it('matches a real skill load (preamble at the start)', () => {
    expect(isSystemContextText('Base directory for this skill: /x/y\n\n# Heading')).toBe(true);
  });

  it('tolerates leading whitespace before the preamble', () => {
    expect(isSystemContextText('\n  Base directory for this skill: /x/y')).toBe(true);
  });

  it('does NOT match when the user pastes/quotes the preamble mid-message', () => {
    const pasted =
      '{\n  "type": "user",\n  "text": "Base directory for this skill: /x/y\\n\\n# Systematic Debugging"\n}';
    expect(isSystemContextText(pasted)).toBe(false);
  });

  it('does NOT match when the preamble appears after some prose', () => {
    expect(isSystemContextText('Here is the message I got:\n\nBase directory for this skill: /x')).toBe(false);
  });

  it('classifyBlockKind returns null (→ user.prompt) for a user text block quoting the preamble', () => {
    const text = 'look at this paste:\n\nBase directory for this skill: /x\n\n# Stuff';
    const node = user([{ type: 'text', text }]);
    expect(classifyBlockKind({ type: 'text', text } as any, node)).toBeNull();
  });
});

// classifyBlockKind only reads `parent.kind`.

const assistant = (
  content: any[],
  stop_reason: string | null = null,
): JsonlNode & { raw: { message: { content: any[] } } } =>
  ({
    kind: 'assistant',
    sessionId: '',
    receivedAt: '',
    raw: { type: 'assistant', message: { role: 'assistant', content, stop_reason } },
  }) as any;

const user = (content: any[]): JsonlNode & { raw: { message: { content: any[] } } } =>
  ({
    kind: 'user',
    userKind: 'prompt',
    sessionId: '',
    receivedAt: '',
    raw: { type: 'user', message: { role: 'user', content } },
  }) as any;

describe('classifyBlockKind', () => {
  it('classifies assistant text blocks', () => {
    const parent = assistant([{ type: 'text', text: 'hello' }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('assistant.text');
  });

  it('returns null for empty assistant text', () => {
    const parent = assistant([{ type: 'text', text: '   ' }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBeNull();
  });

  it('classifies text blocks of an end_turn assistant as assistant.text.endTurn', () => {
    const parent = assistant([{ type: 'text', text: 'done' }], 'end_turn');
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('assistant.text.endTurn');
  });

  it('keeps plain assistant.text for other terminal stop_reasons (max_tokens, refusal, etc.)', () => {
    for (const stop of ['max_tokens', 'stop_sequence', 'refusal', 'model_context_window_exceeded']) {
      const parent = assistant([{ type: 'text', text: 'partial' }], stop);
      expect(classifyBlockKind(parent.raw.message.content[0], parent), `stop=${stop}`).toBe('assistant.text');
    }
  });

  it('keeps plain assistant.text for mid-turn messages (stop_reason: null)', () => {
    const parent = assistant([{ type: 'text', text: 'mid-turn' }], null);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('assistant.text');
  });

  it('classifies assistant thinking blocks with content', () => {
    const parent = assistant([{ type: 'thinking', thinking: 'reasoning…' }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('assistant.thinking');
  });

  it('returns null for signature-only thinking blocks', () => {
    const parent = assistant([{ type: 'thinking', thinking: '', signature: 'sig' }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBeNull();
  });

  it('classifies assistant tool_use blocks as assistant.tool-use', () => {
    const parent = assistant([{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('assistant.tool-use');
  });

  it('classifies assistant tool_use blocks for an unknown tool name as assistant.tool-use (collapsed)', () => {
    const parent = assistant([{ type: 'tool_use', name: 'SomeRandomTool', input: {} }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('assistant.tool-use');
  });

  it('classifies tool_use as assistant.tool-use regardless of name casing', () => {
    const parent = assistant([{ type: 'tool_use', name: 'BASH', input: { command: 'ls' } }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('assistant.tool-use');
  });

  it('classifies subagent dispatch tool_use (Task / Agent) as assistant.tool-use', () => {
    const parent1 = assistant([{ type: 'tool_use', name: 'Task', input: { description: 'x' } }]);
    expect(classifyBlockKind(parent1.raw.message.content[0], parent1)).toBe('assistant.tool-use');
    const parent2 = assistant([{ type: 'tool_use', name: 'Agent', input: { description: 'x' } }]);
    expect(classifyBlockKind(parent2.raw.message.content[0], parent2)).toBe('assistant.tool-use');
  });

  it('classifies every name in KNOWN_TOOL_NAMES as assistant.tool-use', () => {
    for (const name of KNOWN_TOOL_NAMES) {
      const parent = assistant([{ type: 'tool_use', name, input: {} }]);
      const got = classifyBlockKind(parent.raw.message.content[0], parent);
      expect(got, `tool name "${name}" should classify as assistant.tool-use`).toBe('assistant.tool-use');
    }
  });

  it('classifies any mcp__* tool_use as assistant.tool-use', () => {
    const parent = assistant([{ type: 'tool_use', name: 'mcp__foo__bar', input: {} }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('assistant.tool-use');
  });

  it('classifies AskUserQuestion tool_use as the generic assistant.tool-use kind', () => {
    const parent = assistant([
      { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'pick', options: [] }] } },
    ]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('assistant.tool-use');
  });

  it('classifies user image blocks', () => {
    const parent = user([{ type: 'image', source: { type: 'base64', data: '...' } }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('user.image');
  });

  it('classifies user tool_result with system-reminder as user.tool-result (collapsed)', () => {
    const parent = user([
      { type: 'tool_result', content: 'output\n<system-reminder>note</system-reminder>' },
    ]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('user.tool-result');
  });

  it('classifies plain user tool_result as user.tool-result', () => {
    const parent = user([{ type: 'tool_result', content: 'plain output' }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('user.tool-result');
  });

  it('classifies assistant server_tool_use blocks as assistant.serverToolUse', () => {
    const parent = assistant([{
      type: 'server_tool_use',
      id: 'srvtu_1',
      name: 'code_execution',
      input: { code: 'print(1)' },
    }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('assistant.serverToolUse');
  });

  it('classifies user bash_code_execution_tool_result blocks as tool.result.codeExecution', () => {
    const parent = user([{
      type: 'bash_code_execution_tool_result',
      tool_use_id: 'srvtu_1',
      content: { type: 'bash_code_execution_result', return_code: 0, stdout: 'hi\n' },
    }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('tool.result.codeExecution');
  });

  it('classifies user text_editor_code_execution_tool_result blocks as tool.result.codeExecution', () => {
    const parent = user([{
      type: 'text_editor_code_execution_tool_result',
      tool_use_id: 'srvtu_2',
      content: { type: 'text_editor_code_execution_view_result', file_text: 'hello' },
    }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('tool.result.codeExecution');
  });

  it('classifies user text containing system-reminder as systemContext', () => {
    const parent = user([{ type: 'text', text: 'hello\n<system-reminder>x</system-reminder>' }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('user.systemContext');
  });

  it('classifies Stop-hook feedback text as systemContext (not a user prompt)', () => {
    const parent = user([{
      type: 'text',
      text: 'Stop hook feedback:\nYou have 2 unfinished todo items in your latest TodoWrite call:\n  - [pending] foo\n  - [pending] bar',
    }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('user.systemContext');
  });

  it('classifies PreToolUse / PostToolUse hook feedback as systemContext', () => {
    for (const prefix of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SubagentStop', 'Notification']) {
      const parent = user([{ type: 'text', text: `${prefix} hook feedback:\nblocked because reasons` }]);
      expect(
        classifyBlockKind(parent.raw.message.content[0], parent),
        `prefix=${prefix}`,
      ).toBe('user.systemContext');
    }
  });

  it('classifies SessionStart hook additional-context preamble as systemContext', () => {
    const parent = user([{
      type: 'text',
      text: 'SessionStart hook additional context: <EXTREMELY_IMPORTANT>...</EXTREMELY_IMPORTANT>',
    }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('user.systemContext');
  });

  it('does NOT match the hook-feedback pattern when the prefix is mid-line user text', () => {
    const parent = user([{ type: 'text', text: "I read about Stop hook feedback: in the docs and have a question." }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBeNull();
  });

  it('returns null for plain user typed text (handled by whole-message classification)', () => {
    const parent = user([{ type: 'text', text: 'just a normal prompt' }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBeNull();
  });

  it('returns null for unknown block types', () => {
    const parent = assistant([{ type: 'mystery' }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBeNull();
  });

  it('returns null for null/undefined block', () => {
    const parent = assistant([]);
    expect(classifyBlockKind(null, parent)).toBeNull();
    expect(classifyBlockKind(undefined, parent)).toBeNull();
  });
});

describe('classifyBlockKind — tool results carrying images', () => {
  const imageBlock = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
  };

  it('classifies an image-bearing tool_result as user.tool-result.image', () => {
    const parent = user([
      { type: 'tool_result', tool_use_id: 't1', content: [imageBlock] },
    ]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe(
      'user.tool-result.image',
    );
  });

  it('still classifies it as an image result when text accompanies the image', () => {
    const parent = user([
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: [{ type: 'text', text: 'Screenshot captured' }, imageBlock],
      },
    ]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe(
      'user.tool-result.image',
    );
  });

  it('leaves image-free tool results on user.tool-result', () => {
    const parent = user([
      { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] },
    ]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('user.tool-result');
  });

  it('leaves string-content tool results on user.tool-result', () => {
    const parent = user([{ type: 'tool_result', tool_use_id: 't1', content: 'done' }]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('user.tool-result');
  });

  it('leaves a top-level pasted image on user.image', () => {
    const parent = user([imageBlock]);
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBe('user.image');
  });
});

// Claude Code 2.1.234 no longer crashes on blocks without the narrative field,
// so the shape reaches the classifier.
describe('classifyBlockKind — block missing its narrative field (CLI 2.1.234 class)', () => {
  it('treats a thinking block with no `thinking` field as empty', () => {
    const parent = assistant([{ type: 'thinking', signature: 'sig' }]);
    expect(() => classifyBlockKind(parent.raw.message.content[0], parent)).not.toThrow();
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBeNull();
  });

  it('treats a text block with no `text` field as empty', () => {
    const parent = assistant([{ type: 'text' }]);
    expect(() => classifyBlockKind(parent.raw.message.content[0], parent)).not.toThrow();
    expect(classifyBlockKind(parent.raw.message.content[0], parent)).toBeNull();
  });

  it('treats a user text block with no `text` field as empty', () => {
    const parent = user([{ type: 'text' }]);
    expect(() => classifyBlockKind(parent.raw.message.content[0], parent)).not.toThrow();
  });
});
