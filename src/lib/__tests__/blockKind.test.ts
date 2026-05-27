import { describe, it, expect } from 'vitest';
import { classifyBlockKind, isBlockHiddenInCompact } from '../blockKind';
import { createDefaultConfig } from '../messageRenderingConfig';
import { KNOWN_TOOL_NAMES } from '../types/toolInput';
import type { ClaudeStreamMessage } from '@/types/claudeStream';

// Test factories return a structural mock whose `.message.content` is always
// present. We declare the narrow shape we want to use at access sites so the
// strict ClaudeStreamMessage union doesn't force callers through `as any`.
type AssistantStub = ClaudeStreamMessage & { message: { content: any[] } };
type UserStub = ClaudeStreamMessage & { message: { content: any[] } };

const assistant = (content: any[]): AssistantStub =>
  ({ type: 'assistant', message: { content } }) as any;

const user = (content: any[]): UserStub =>
  ({ type: 'user', message: { content } }) as any;

describe('classifyBlockKind', () => {
  it('classifies assistant text blocks', () => {
    const parent = assistant([{ type: 'text', text: 'hello' }]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBe('assistant.text');
  });

  it('returns null for empty assistant text', () => {
    const parent = assistant([{ type: 'text', text: '   ' }]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBeNull();
  });

  it('classifies assistant thinking blocks with content', () => {
    const parent = assistant([{ type: 'thinking', thinking: 'reasoning…' }]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBe('assistant.thinking');
  });

  it('returns null for signature-only thinking blocks', () => {
    const parent = assistant([{ type: 'thinking', thinking: '', signature: 'sig' }]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBeNull();
  });

  it('classifies assistant tool_use blocks as assistant.tool-use', () => {
    const parent = assistant([{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBe('assistant.tool-use');
  });

  it('classifies assistant tool_use blocks for an unknown tool name as assistant.tool-use (collapsed)', () => {
    // v2 catalog has a single assistant.tool-use row — no per-tool sub-IDs.
    // Unknown tool names collapse to the same row so the renderer lookup
    // always hits the catalog rather than falling to the unknown catch-all.
    const parent = assistant([{ type: 'tool_use', name: 'SomeRandomTool', input: {} }]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBe('assistant.tool-use');
  });

  it('classifies tool_use as assistant.tool-use regardless of name casing', () => {
    const parent = assistant([{ type: 'tool_use', name: 'BASH', input: { command: 'ls' } }]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBe('assistant.tool-use');
  });

  it('classifies subagent dispatch tool_use (Task / Agent) as assistant.tool-use', () => {
    const parent1 = assistant([{ type: 'tool_use', name: 'Task', input: { description: 'x' } }]);
    expect(classifyBlockKind(parent1.message.content[0], parent1)).toBe('assistant.tool-use');
    const parent2 = assistant([{ type: 'tool_use', name: 'Agent', input: { description: 'x' } }]);
    expect(classifyBlockKind(parent2.message.content[0], parent2)).toBe('assistant.tool-use');
  });

  // All tool_use blocks — known or unknown — return the single v2 catalog ID
  // `assistant.tool-use`. This test pins the invariant so any regression to
  // per-tool sub-IDs or a known/unknown split breaks loudly.
  it('classifies every name in KNOWN_TOOL_NAMES as assistant.tool-use', () => {
    for (const name of KNOWN_TOOL_NAMES) {
      const parent = assistant([{ type: 'tool_use', name, input: {} }]);
      const got = classifyBlockKind(parent.message.content[0], parent);
      expect(got, `tool name "${name}" should classify as assistant.tool-use`).toBe('assistant.tool-use');
    }
  });

  it('classifies any mcp__* tool_use as assistant.tool-use', () => {
    const parent = assistant([{ type: 'tool_use', name: 'mcp__foo__bar', input: {} }]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBe('assistant.tool-use');
  });

  it('classifies AskUserQuestion tool_use as its own answered-pair kind', () => {
    // Pairs with the tool_result via the StreamMessage widget so scrollback
    // shows a single Q+A card rather than blending into generic toolUse.
    const parent = assistant([
      { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'pick', options: [] }] } },
    ]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBe('tool.askUserQuestion.answered');
  });

  it('AskUserQuestion classification is case-insensitive on the tool name', () => {
    const parent = assistant([
      { type: 'tool_use', name: 'askuserquestion', input: { questions: [] } },
    ]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBe('tool.askUserQuestion.answered');
  });

  it('classifies user image blocks', () => {
    const parent = user([{ type: 'image', source: { type: 'base64', data: '...' } }]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBe('user.image');
  });

  it('classifies user tool_result with system-reminder as user.tool-result (collapsed)', () => {
    // v2 catalog has a single user.tool-result row; sub-variants (systemReminder,
    // generic) were collapsed so the renderer lookup always hits the catalog.
    const parent = user([
      { type: 'tool_result', content: 'output\n<system-reminder>note</system-reminder>' },
    ]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBe('user.tool-result');
  });

  it('classifies plain user tool_result as user.tool-result', () => {
    const parent = user([{ type: 'tool_result', content: 'plain output' }]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBe('user.tool-result');
  });

  // The Agent SDK doesn't currently surface server-side tool blocks through
  // the CLI, but if Anthropic ever exposes the code-execution tool surface
  // (server_tool_use + bash_code_execution_tool_result +
  // text_editor_code_execution_tool_result blocks per the Messages API),
  // the renderer needs to recognize them rather than fall through to the
  // "unknown" catch-all.
  it('classifies assistant server_tool_use blocks as assistant.serverToolUse', () => {
    const parent = assistant([{
      type: 'server_tool_use',
      id: 'srvtu_1',
      name: 'code_execution',
      input: { code: 'print(1)' },
    }]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBe('assistant.serverToolUse');
  });

  it('classifies user bash_code_execution_tool_result blocks as tool.result.codeExecution', () => {
    const parent = user([{
      type: 'bash_code_execution_tool_result',
      tool_use_id: 'srvtu_1',
      content: { type: 'bash_code_execution_result', return_code: 0, stdout: 'hi\n' },
    }]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBe('tool.result.codeExecution');
  });

  it('classifies user text_editor_code_execution_tool_result blocks as tool.result.codeExecution', () => {
    const parent = user([{
      type: 'text_editor_code_execution_tool_result',
      tool_use_id: 'srvtu_2',
      content: { type: 'text_editor_code_execution_view_result', file_text: 'hello' },
    }]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBe('tool.result.codeExecution');
  });

  it('classifies user text containing system-reminder as systemContext', () => {
    const parent = user([{ type: 'text', text: 'hello\n<system-reminder>x</system-reminder>' }]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBe('user.systemContext');
  });

  it('classifies Stop-hook feedback text as systemContext (not a user prompt)', () => {
    const parent = user([{
      type: 'text',
      text: 'Stop hook feedback:\nYou have 2 unfinished todo items in your latest TodoWrite call:\n  - [pending] foo\n  - [pending] bar',
    }]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBe('user.systemContext');
  });

  it('classifies PreToolUse / PostToolUse hook feedback as systemContext', () => {
    for (const prefix of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SubagentStop', 'Notification']) {
      const parent = user([{ type: 'text', text: `${prefix} hook feedback:\nblocked because reasons` }]);
      expect(
        classifyBlockKind(parent.message.content[0], parent),
        `prefix=${prefix}`,
      ).toBe('user.systemContext');
    }
  });

  it('classifies SessionStart hook additional-context preamble as systemContext', () => {
    const parent = user([{
      type: 'text',
      text: 'SessionStart hook additional context: <EXTREMELY_IMPORTANT>...</EXTREMELY_IMPORTANT>',
    }]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBe('user.systemContext');
  });

  it('does NOT match the hook-feedback pattern when the prefix is mid-line user text', () => {
    // A user genuinely typing about hooks should not get reclassified.
    const parent = user([{ type: 'text', text: "I read about Stop hook feedback: in the docs and have a question." }]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBeNull();
  });

  it('returns null for plain user typed text (handled by whole-message classification)', () => {
    const parent = user([{ type: 'text', text: 'just a normal prompt' }]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBeNull();
  });

  it('returns null for unknown block types', () => {
    const parent = assistant([{ type: 'mystery' }]);
    expect(classifyBlockKind(parent.message.content[0], parent)).toBeNull();
  });

  it('returns null for null/undefined block', () => {
    const parent = assistant([]);
    expect(classifyBlockKind(null, parent)).toBeNull();
    expect(classifyBlockKind(undefined, parent)).toBeNull();
  });
});

describe('isBlockHiddenInCompact', () => {
  it('hides assistant.tool-use by default', () => {
    const config = createDefaultConfig();
    const parent = assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]);
    expect(isBlockHiddenInCompact(parent.message.content[0], parent, config)).toBe(true);
  });

  it('shows assistant.text by default', () => {
    const config = createDefaultConfig();
    const parent = assistant([{ type: 'text', text: 'reply' }]);
    expect(isBlockHiddenInCompact(parent.message.content[0], parent, config)).toBe(false);
  });

  it('hides user.tool-result by default', () => {
    const config = createDefaultConfig();
    const parent = user([{ type: 'tool_result', content: 'output' }]);
    expect(isBlockHiddenInCompact(parent.message.content[0], parent, config)).toBe(true);
  });

  it('respects user override that unhides assistant.thinking', () => {
    const config = createDefaultConfig();
    config.kinds['assistant.thinking'].hiddenInCompact = false;
    const parent = assistant([{ type: 'thinking', thinking: 'deep' }]);
    expect(isBlockHiddenInCompact(parent.message.content[0], parent, config)).toBe(false);
  });

  it('returns false for unclassified blocks', () => {
    const config = createDefaultConfig();
    const parent = user([{ type: 'text', text: 'plain typed prompt' }]);
    expect(isBlockHiddenInCompact(parent.message.content[0], parent, config)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lastCardIdx regression — mirrors the algorithm in StreamMessage.tsx so
// we can verify that compact mode correctly skips hiddenInCompact blocks when
// selecting the toolbar anchor.
// ---------------------------------------------------------------------------
describe('lastCardIdx algorithm (compact toolbar anchor)', () => {
  /**
   * Re-implements the StreamMessage lastCardIdx IIFE so we can unit-test the
   * logic without mounting the full component. This must stay in sync with the
   * implementation in StreamMessage.tsx.
   */
  function computeLastCardIdx(
    visibleBlocks: any[],
    message: ClaudeStreamMessage,
    renderConfig: ReturnType<typeof createDefaultConfig>,
    hidingActive: boolean,
  ): number {
    let last = visibleBlocks.length - 1;
    for (let i = visibleBlocks.length - 1; i >= 0; i--) {
      const blockKind = classifyBlockKind(visibleBlocks[i], message);
      const presentation = blockKind
        ? ((renderConfig.kinds[blockKind]?.presentation ?? 'card') as string)
        : 'card';
      if (presentation !== 'card') continue;
      if (hidingActive) {
        const willBeHidden = isBlockHiddenInCompact(visibleBlocks[i], message, renderConfig);
        if (willBeHidden) continue;
      }
      last = i;
      break;
    }
    return last;
  }

  it('[text, tool_use, tool_use] compact=true → lastCardIdx=0 (text block, not last tool_use)', () => {
    // This is the critical regression case from the bug report.
    // Before the fix, lastCardIdx was 2 (last tool_use), which is hiddenInCompact.
    // The toolbar would render inside HiddenBlocksExpander (collapsed) — invisible.
    // After the fix, lastCardIdx is 0 (the text block), which is always visible.
    const config = createDefaultConfig();
    const blocks = [
      { type: 'text', text: 'Here is the result.' },
      { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ];
    const message = assistant(blocks);
    const visibleBlocks = blocks; // none suppressed
    expect(computeLastCardIdx(visibleBlocks, message, config, true)).toBe(0);
  });

  it('[text, tool_use, tool_use] compact=false → lastCardIdx=2 (last block wins without compact filter)', () => {
    // Without compact mode, the old behaviour is preserved: last card block wins.
    const config = createDefaultConfig();
    const blocks = [
      { type: 'text', text: 'Here is the result.' },
      { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ];
    const message = assistant(blocks);
    const visibleBlocks = blocks;
    expect(computeLastCardIdx(visibleBlocks, message, config, false)).toBe(2);
  });

  it('[tool_use, tool_use] compact=true, all blocks hidden → falls back to last block (index 1)', () => {
    // When every visible block is hiddenInCompact the fallback is the last
    // block (index length-1). This matches the "last block of any kind"
    // fallback in the implementation.
    const config = createDefaultConfig();
    const blocks = [
      { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ];
    const message = assistant(blocks);
    const visibleBlocks = blocks;
    expect(computeLastCardIdx(visibleBlocks, message, config, true)).toBe(1);
  });

  it('[text] compact=true → lastCardIdx=0 (single visible card block)', () => {
    const config = createDefaultConfig();
    const blocks = [{ type: 'text', text: 'Single reply.' }];
    const message = assistant(blocks);
    expect(computeLastCardIdx(blocks, message, config, true)).toBe(0);
  });
});
