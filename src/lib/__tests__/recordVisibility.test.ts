import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { isMessageFullyHidden, withoutNeverShown } from '../recordVisibility';
import { createDefaultConfig, type MessageRenderingConfig } from '../messageRenderingConfig';

function unhide(cfg: MessageRenderingConfig, id: string): void {
  cfg.kinds[id] = { ...cfg.kinds[id], visibility: 'always' };
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

  it('never hides a queued feedback draft in compact mode', () => {
    // The system category defaults to verbose-only. A feedback draft is
    // the only sign the CLI queued one — burying it in compact mode means the
    // user never learns it exists, since OmniFex has no /feedback surface.
    const cfg = createDefaultConfig();
    const msg = {
      kind: 'system', subtype: 'feedback_draft_queued', sessionId: '', receivedAt: '',
      raw: {
        type: 'system', subtype: 'feedback_draft_queued', draft_type: 'bug',
        title: 'Edit reported success on a no-op',
        details_preview: 'The Edit tool returned success but the file was unchanged.',
      },
    } as unknown as JsonlNode;
    expect(isMessageFullyHidden(msg, [msg], cfg)).toBe(false);
  });

  it('never hides an answered AskUserQuestion assistant message (tool.askUserQuestion.answered)', () => {
    // Regression: sentinel id head is "tool" → originOf returns "system" →
    // system category is verbose-only → card vanishes in compact mode.
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

  it('never hides compactBoundaryLocked kinds even if their visibility is forced off', () => {
    // user.prompt is compactBoundaryLocked in the registry; forcing a hidden
    // visibility on a locked kind must still return visible=false
    // (defense in depth — compactBoundaryLocked short-circuits the hidden check).
    const cfg = createDefaultConfig();
    cfg.kinds['user.prompt'] = { ...cfg.kinds['user.prompt'], visibility: 'verbose' };
    const msg = userText('hi');
    expect(isMessageFullyHidden(msg, [msg], cfg)).toBe(false);
  });
});

describe('withoutNeverShown', () => {
  function never(cfg: MessageRenderingConfig, id: string): void {
    cfg.kinds[id] = { ...cfg.kinds[id], visibility: 'never' };
  }
  const localCommand = {
    kind: 'system', subtype: 'local_command', sessionId: '', receivedAt: '',
    raw: { type: 'system', subtype: 'local_command', content: '<local-command-stdout>hi</local-command-stdout>' },
  } as unknown as JsonlNode;

  it('keeps everything by default', () => {
    const cfg = createDefaultConfig();
    const msgs = [userText('hi'), toolUseMsg('Bash'), localCommand];
    expect(withoutNeverShown(msgs, cfg)).toEqual(msgs);
  });

  it('drops a message whose whole kind is set to never', () => {
    const cfg = createDefaultConfig();
    never(cfg, 'system.local_command');
    const prompt = userText('hi');
    expect(withoutNeverShown([prompt, localCommand], cfg)).toEqual([prompt]);
  });

  it('drops a message only when every renderable block is never', () => {
    const cfg = createDefaultConfig();
    never(cfg, 'assistant.tool-use');
    never(cfg, 'assistant.thinking');
    const allNever = assistantWithBlocks([{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', name: 'Bash', input: {} }], 'tool_use');
    const mixed = assistantWithBlocks([{ type: 'text', text: 'here' }, { type: 'tool_use', name: 'Bash', input: {} }], 'tool_use');
    expect(withoutNeverShown([allNever, mixed], cfg)).toEqual([mixed]);
  });

  it('keeps boundary-locked kinds and messages with nothing to classify', () => {
    const cfg = createDefaultConfig();
    never(cfg, 'user.prompt');
    const prompt = userText('hi');
    const empty = assistantWithBlocks([]);
    expect(withoutNeverShown([prompt, empty], cfg)).toEqual([prompt, empty]);
  });
});

// A hidden run with nothing countable in it would render an empty expander —
// no row at all is the only honest output.
