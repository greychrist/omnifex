import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { buildCompactItems, isMessageFullyHidden, type CompactItem } from '../compactGrouping';
import {
  createDefaultConfig,
  resolveKind,
  KIND_REGISTRY,
  type MessageRenderingConfig,
} from '../messageRenderingConfig';

// v5 model: per-kind overrides live in config.kinds[id] (sparse Partial<KindStyle>).
function styleForKind(cfg: MessageRenderingConfig, id: string) {
  return resolveKind(cfg, id);
}
function unhide(cfg: MessageRenderingConfig, id: string): void {
  cfg.kinds[id] = { ...cfg.kinds[id], hiddenInCompact: false };
}

function userText(text: string): JsonlNode {
  return { kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '', raw: { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } } } as unknown as JsonlNode;
}

function toolUseMsg(name: string, input: any = {}): JsonlNode {
  return {
    kind: 'assistant', sessionId: '', receivedAt: '',
    raw: {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name, input }], stop_reason: 'tool_use' },
    },
  } as unknown as JsonlNode;
}

function assistantWithBlocks(blocks: any[], stop_reason = 'end_turn'): JsonlNode {
  return {
    kind: 'assistant', sessionId: '', receivedAt: '',
    raw: { type: 'assistant', message: { role: 'assistant', content: blocks, stop_reason } },
  } as unknown as JsonlNode;
}

function toolResultMsg(toolUseId = 'tu_x'): JsonlNode {
  return {
    kind: 'user', userKind: 'tool-result', sessionId: '', receivedAt: '',
    raw: {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
    },
  } as unknown as JsonlNode;
}

function assistantEndTurn(text: string): JsonlNode {
  return assistantWithBlocks([{ type: 'text', text }]);
}

/**
 * Build the pair of messages that represents an answered AskUserQuestion:
 * - the assistant message with only AskUserQuestion tool_use (classifies to
 *   `tool.askUserQuestion.answered`)
 * - the user message with the matching tool_result (classifies to
 *   `tool.askUserQuestion.answered.result`)
 */
function answeredAskUserQuestionPair(toolUseId = 'tu_auq'): { assistant: JsonlNode; result: JsonlNode } {
  const assistant: JsonlNode = {
    kind: 'assistant', sessionId: '', receivedAt: '',
    raw: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'AskUserQuestion', input: { question: 'What do you need?' } }],
        stop_reason: 'tool_use',
      },
    },
  } as unknown as JsonlNode;
  const result: JsonlNode = {
    kind: 'user', userKind: 'tool-result', sessionId: '', receivedAt: '',
    raw: {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'My answer' }] },
    },
  } as unknown as JsonlNode;
  return { assistant, result };
}

describe('isMessageFullyHidden', () => {
  it('returns false for a user prompt (locked visible)', () => {
    const cfg = createDefaultConfig();
    expect(isMessageFullyHidden(userText('hi'), [], cfg)).toBe(false);
  });

  it('returns false for a final assistant text (assistant.text not hidden by default)', () => {
    const cfg = createDefaultConfig();
    expect(isMessageFullyHidden(assistantEndTurn('done'), [], cfg)).toBe(false);
  });

  it('returns true for a tool_use-only assistant message in compact default', () => {
    const cfg = createDefaultConfig();
    const msg = toolUseMsg('Read', { file_path: '/a' });
    expect(isMessageFullyHidden(msg, [msg], cfg)).toBe(true);
  });

  it('returns true for a tool_result-only user message', () => {
    const cfg = createDefaultConfig();
    const msg = toolResultMsg();
    expect(isMessageFullyHidden(msg, [msg], cfg)).toBe(true);
  });

  it('returns false for a mixed assistant message with visible text + hidden tool_use', () => {
    const cfg = createDefaultConfig();
    const msg = assistantWithBlocks([
      { type: 'text', text: 'Let me check that.' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/a' } },
    ]);
    expect(isMessageFullyHidden(msg, [msg], cfg)).toBe(false);
  });

  it('returns true when user unhides nothing and message is all hidden blocks', () => {
    const cfg = createDefaultConfig();
    const msg = assistantWithBlocks([
      { type: 'thinking', thinking: 'pondering' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/a' } },
    ]);
    expect(isMessageFullyHidden(msg, [msg], cfg)).toBe(true);
  });

  it('respects user toggle that unhides assistant.tool-use', () => {
    const cfg = createDefaultConfig();
    unhide(cfg, 'assistant.tool-use');
    const msg = toolUseMsg('Read', { file_path: '/a' });
    expect(isMessageFullyHidden(msg, [msg], cfg)).toBe(false);
  });

  it('returns false for system.unknown when user unhides it', () => {
    const cfg = createDefaultConfig();
    unhide(cfg, 'system.unknown');
    const msg = { kind: 'system', subtype: 'init', sessionId: '', receivedAt: '', raw: { type: 'system', subtype: 'init' } } as unknown as JsonlNode;
    expect(isMessageFullyHidden(msg, [msg], cfg)).toBe(false);
  });

  it('returns true for hidden system.unknown (e.g. system:init) by default', () => {
    const cfg = createDefaultConfig();
    const msg = { kind: 'system', subtype: 'init', sessionId: '', receivedAt: '', raw: { type: 'system', subtype: 'init' } } as unknown as JsonlNode;
    expect(isMessageFullyHidden(msg, [msg], cfg)).toBe(true);
  });

  it('never hides an answered AskUserQuestion assistant message (tool.askUserQuestion.answered)', () => {
    // Regression: sentinel id head is "tool" → originOf returns "system" →
    // system category has hiddenInCompact:true → card vanishes in compact mode.
    const cfg = createDefaultConfig();
    const { assistant, result } = answeredAskUserQuestionPair();
    const allMsgs = [assistant, result];
    expect(isMessageFullyHidden(assistant, allMsgs, cfg)).toBe(false);
  });

  it('never hides an answered AskUserQuestion result message (tool.askUserQuestion.answered.result)', () => {
    const cfg = createDefaultConfig();
    const { assistant, result } = answeredAskUserQuestionPair();
    const allMsgs = [assistant, result];
    expect(isMessageFullyHidden(result, allMsgs, cfg)).toBe(false);
  });

  it('never hides compactBoundaryLocked kinds even if hiddenInCompact is forced true', () => {
    // user.prompt is compactBoundaryLocked in the registry; forcing
    // hiddenInCompact:true on a locked kind must still return visible=false
    // (defense in depth — compactBoundaryLocked short-circuits the hidden check).
    const cfg = createDefaultConfig();
    // Forced bypass attempt: set hiddenInCompact:true on user.prompt via config.kinds.
    cfg.kinds['user.prompt'] = { ...cfg.kinds['user.prompt'], hiddenInCompact: true };
    const msg = userText('hi');
    expect(isMessageFullyHidden(msg, [msg], cfg)).toBe(false);
  });
});

describe('buildCompactItems', () => {
  it('returns singles for a transcript with only visible messages', () => {
    const cfg = createDefaultConfig();
    const msgs = [userText('hi'), assistantEndTurn('hello')];
    const items = buildCompactItems(msgs, cfg);
    expect(items.map((i: CompactItem) => i.kind)).toEqual(['single', 'single']);
  });

  it('groups consecutive fully-hidden messages between visible ones', () => {
    const cfg = createDefaultConfig();
    const msgs = [
      userText('do stuff'),
      toolUseMsg('Read', { file_path: '/a' }),
      toolResultMsg(),
      toolUseMsg('Bash', { command: 'ls' }),
      toolResultMsg(),
      assistantEndTurn('done'),
    ];
    const items = buildCompactItems(msgs, cfg);
    expect(items.map((i: CompactItem) => i.kind)).toEqual(['single', 'group', 'single']);
    if (items[1].kind === 'group') {
      expect(items[1].messages.length).toBe(4);
    }
  });

  it('renders a partially-hidden assistant message as a visible single', () => {
    const cfg = createDefaultConfig();
    const mixed = assistantWithBlocks([
      { type: 'text', text: 'Reading those files now.' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/a' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/b' } },
    ], 'tool_use');
    const msgs = [userText('check'), mixed, toolResultMsg(), assistantEndTurn('done')];
    const items = buildCompactItems(msgs, cfg);
    // user + mixed(single) + tool_result(group) + assistant(single)
    expect(items.map((i: CompactItem) => i.kind)).toEqual([
      'single',
      'single',
      'group',
      'single',
    ]);
  });

  it('promotes a kind to single when user unhides it', () => {
    const cfg = createDefaultConfig();
    unhide(cfg, 'system.unknown');
    const sysInit = { kind: 'system', subtype: 'init', sessionId: '', receivedAt: '', raw: { type: 'system', subtype: 'init' } } as unknown as JsonlNode;
    const msgs = [
      userText('hi'),
      sysInit,
      toolUseMsg('Read', { file_path: '/a' }),
      toolResultMsg(),
      assistantEndTurn('done'),
    ];
    const items = buildCompactItems(msgs, cfg);
    expect(items.map((i: CompactItem) => i.kind)).toEqual([
      'single',
      'single',
      'group',
      'single',
    ]);
  });

  it('falls back to all-singles when user unhides everything', () => {
    const cfg = createDefaultConfig();
    for (const id of Object.keys(KIND_REGISTRY)) {
      if (!styleForKind(cfg, id).compactBoundaryLocked) {
        unhide(cfg, id);
      }
    }
    const msgs = [
      userText('hi'),
      toolUseMsg('Read', { file_path: '/a' }),
      toolResultMsg(),
      assistantEndTurn('done'),
    ];
    const items = buildCompactItems(msgs, cfg);
    expect(items.every((i) => i.kind === 'single')).toBe(true);
  });

  it('produces a single big group when everything is hidden', () => {
    const cfg = createDefaultConfig();
    const msgs = [
      toolUseMsg('Read', { file_path: '/a' }),
      toolResultMsg(),
      toolUseMsg('Bash', { command: 'ls' }),
      toolResultMsg(),
    ];
    const items = buildCompactItems(msgs, cfg);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('group');
  });

  it('handles empty input', () => {
    expect(buildCompactItems([], createDefaultConfig())).toEqual([]);
  });

  it('keeps answered AskUserQuestion pair visible (not grouped) in compact mode', () => {
    // Regression guard: tool.askUserQuestion.answered / .result must never be
    // folded into a HiddenEventsGroup — the Q+A card is user-facing content.
    const cfg = createDefaultConfig();
    const { assistant, result } = answeredAskUserQuestionPair();
    const msgs = [
      userText('please ask me something'),
      assistant,
      result,
      assistantEndTurn('Thanks for your answer.'),
    ];
    const items = buildCompactItems(msgs, cfg);
    // All four messages should be visible singles — none collapsed into a group.
    expect(items.map((i: CompactItem) => i.kind)).toEqual(['single', 'single', 'single', 'single']);
  });

  it('treats reloaded user prompts (originally bare strings in JSONL) as visible', () => {
    const cfg = createDefaultConfig();
    // Boundary normalization (lib/normalizeMessage) wraps the CLI's
    // bare-string user prompts into a single-text-block array at ingress, so
    // by the time buildCompactItems sees them they're array-shaped. This
    // test pins the behaviour for "what was originally a CLI bare-string
    // prompt, now arriving normalized" — the case that previously needed a
    // dedicated string-content branch in isMessageFullyHidden.
    const reloadedPrompt = {
      kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '',
      raw: { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello from a reloaded session' }] } },
    } as unknown as JsonlNode;
    const msgs = [
      reloadedPrompt,
      toolUseMsg('Read', { file_path: '/a' }),
      toolResultMsg(),
      assistantEndTurn('done'),
    ];
    const items = buildCompactItems(msgs, cfg);
    expect(items.map((i: CompactItem) => i.kind)).toEqual(['single', 'group', 'single']);
    if (items[0].kind === 'single') {
      expect(items[0].message).toBe(reloadedPrompt);
    }
  });

  it('does not break runs around messages that render to nothing', () => {
    const cfg = createDefaultConfig();
    // signature-only thinking renders to null; it should join the run
    // around it instead of acting as a visible single.
    const sigOnlyThinking = assistantWithBlocks([
      { type: 'thinking', thinking: '', signature: 'x' },
    ], 'tool_use');
    const msgs = [
      userText('hi'),
      toolUseMsg('Read', { file_path: '/a' }),
      toolResultMsg(),
      sigOnlyThinking,
      toolUseMsg('Bash', { command: 'ls' }),
      toolResultMsg(),
      assistantEndTurn('done'),
    ];
    const items = buildCompactItems(msgs, cfg);
    // user + ONE merged group + final
    expect(items.map((i: CompactItem) => i.kind)).toEqual(['single', 'group', 'single']);
    if (items[1].kind === 'group') {
      expect(items[1].messages).toContain(sigOnlyThinking);
      expect(items[1].messages).toHaveLength(5);
    }
  });

  it('treats messages with no content array as run-mergeable', () => {
    const cfg = createDefaultConfig();
    const empty = { kind: 'assistant', sessionId: '', receivedAt: '', raw: { type: 'assistant', message: { role: 'assistant', content: [] } } } as unknown as JsonlNode;
    const msgs = [
      userText('hi'),
      toolUseMsg('Read', { file_path: '/a' }),
      empty,
      toolUseMsg('Bash', { command: 'ls' }),
      assistantEndTurn('done'),
    ];
    const items = buildCompactItems(msgs, cfg);
    expect(items.map((i: CompactItem) => i.kind)).toEqual(['single', 'group', 'single']);
  });

  it("folds a fully-hidden tool-use message into a group", () => {
    const cfg = createDefaultConfig();
    const toolUse = {
      kind: "assistant", sessionId: "", receivedAt: "",
      raw: { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", id: "t1", input: {} }] } },
    } as never;
    // assistant.tool-use default is hiddenInCompact:true and not boundary-locked
    const items = buildCompactItems([toolUse], cfg);
    expect(items[0].kind).toBe("group");
  });

  it('groups Task dispatch / return alongside other hidden tool calls when their kinds are hidden', () => {
    // Subagent dispatch / return follow the kind toggles like every other
    // tool — assistant.tool-use and user.tool-result are hidden by
    // default, so Task tool_use + tool_result fold into the surrounding
    // hidden run instead of being special-cased visible.
    const cfg = createDefaultConfig();
    const taskDispatch = {
      kind: 'assistant', sessionId: '', receivedAt: '',
      raw: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_task', name: 'Task', input: { description: 'Investigate' } },
          ],
          stop_reason: 'tool_use',
        },
      },
    } as unknown as JsonlNode;
    const taskReturn = {
      kind: 'user', userKind: 'tool-result', sessionId: '', receivedAt: '',
      raw: {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_task', content: 'done' }],
        },
      },
    } as unknown as JsonlNode;
    const msgs = [
      userText('investigate'),
      toolUseMsg('Bash', { command: 'ls' }),
      toolResultMsg(),
      taskDispatch,
      taskReturn,
      toolUseMsg('Read', { file_path: '/a' }),
      toolResultMsg(),
      assistantEndTurn('done'),
    ];
    const items = buildCompactItems(msgs, cfg);
    expect(items.map((i: CompactItem) => i.kind)).toEqual(['single', 'group', 'single']);
    if (items[1].kind === 'group') {
      expect(items[1].messages).toContain(taskDispatch);
      expect(items[1].messages).toContain(taskReturn);
    }
  });
});
