import { describe, it, expect } from 'vitest';
import type { ClaudeStreamMessage } from '@/components/AgentExecution';
import { buildCompactItems, isBoundaryMessage, type CompactItem } from '../compactGrouping';

function userText(text: string): ClaudeStreamMessage {
  return { type: 'user', message: { content: [{ type: 'text', text }] } } as ClaudeStreamMessage;
}

function toolUseMsg(name: string, input: any = {}): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name, input }],
      stop_reason: 'tool_use',
    },
  } as unknown as ClaudeStreamMessage;
}

function toolResultMsg(): ClaudeStreamMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'ok' }] },
  } as unknown as ClaudeStreamMessage;
}

function assistantEndTurn(text: string): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    },
  } as unknown as ClaudeStreamMessage;
}

describe('isBoundaryMessage', () => {
  it('treats user text as boundary', () => {
    expect(isBoundaryMessage(userText('hello'))).toBe(true);
  });

  it('treats tool_result-only user message as non-boundary', () => {
    expect(isBoundaryMessage(toolResultMsg())).toBe(false);
  });

  it('treats tool_use assistant message as non-boundary', () => {
    expect(isBoundaryMessage(toolUseMsg('Read', { file_path: '/a' }))).toBe(false);
  });

  it('treats end_turn assistant text as boundary', () => {
    expect(isBoundaryMessage(assistantEndTurn('done'))).toBe(true);
  });
});

describe('buildCompactItems', () => {
  it('returns singles for all-boundary transcripts', () => {
    const msgs = [userText('hi'), assistantEndTurn('hello')];
    const items = buildCompactItems(msgs);
    expect(items.map((i: CompactItem) => i.kind)).toEqual(['single', 'single']);
  });

  it('groups consecutive non-boundary messages', () => {
    const msgs = [
      userText('do stuff'),
      toolUseMsg('Read', { file_path: '/a' }),
      toolResultMsg(),
      toolUseMsg('Bash', { command: 'ls' }),
      toolResultMsg(),
      assistantEndTurn('done'),
    ];
    const items = buildCompactItems(msgs);
    expect(items.map((i: CompactItem) => i.kind)).toEqual(['single', 'group', 'single']);
    if (items[1].kind === 'group') {
      expect(items[1].messages.length).toBe(4);
    }
  });

  it('promotes the latest TodoWrite tool_use to a single item', () => {
    const latestTodo = toolUseMsg('TodoWrite', { todos: [{ content: 'x', status: 'in_progress' }] });
    const msgs = [
      userText('do stuff'),
      toolUseMsg('Read', { file_path: '/a' }),
      toolResultMsg(),
      latestTodo,
      toolResultMsg(),
      toolUseMsg('Bash', { command: 'ls' }),
      toolResultMsg(),
      assistantEndTurn('done'),
    ];
    const items = buildCompactItems(msgs);
    // user(single) + group(Read+result) + todo(single) + group(result+Bash+result) + assistant(single)
    expect(items.map((i: CompactItem) => i.kind)).toEqual(['single', 'group', 'single', 'group', 'single']);
    const promoted = items[2];
    expect(promoted.kind).toBe('single');
    if (promoted.kind === 'single') {
      expect(promoted.message).toBe(latestTodo);
    }
  });

  it('only promotes the LAST TodoWrite when multiple exist', () => {
    const earlierTodo = toolUseMsg('TodoWrite', { todos: [{ content: 'a', status: 'pending' }] });
    const latestTodo = toolUseMsg('TodoWrite', { todos: [{ content: 'a', status: 'in_progress' }] });
    const msgs = [
      userText('work'),
      earlierTodo,
      toolResultMsg(),
      toolUseMsg('Bash', { command: 'ls' }),
      toolResultMsg(),
      latestTodo,
      toolResultMsg(),
      assistantEndTurn('done'),
    ];
    const items = buildCompactItems(msgs);
    // user + group(earlierTodo+result+Bash+result) + latestTodo(single) + group(result) + assistant
    expect(items.map((i: CompactItem) => i.kind)).toEqual(['single', 'group', 'single', 'group', 'single']);
    const promoted = items[2];
    if (promoted.kind === 'single') {
      expect(promoted.message).toBe(latestTodo);
    }
    // earlierTodo must be inside the first group, not promoted
    const firstGroup = items[1];
    if (firstGroup.kind === 'group') {
      expect(firstGroup.messages).toContain(earlierTodo);
    }
  });

  it('handles TodoWrite as the only non-boundary message cleanly', () => {
    const todo = toolUseMsg('TodoWrite', { todos: [] });
    const msgs = [userText('go'), todo, assistantEndTurn('done')];
    const items = buildCompactItems(msgs);
    // user(single) + todo(single) + assistant(single) — no empty groups
    expect(items.map((i: CompactItem) => i.kind)).toEqual(['single', 'single', 'single']);
  });

  it('no-ops when transcript has no TodoWrite', () => {
    const msgs = [
      userText('hi'),
      toolUseMsg('Read', { file_path: '/a' }),
      toolResultMsg(),
      assistantEndTurn('done'),
    ];
    const items = buildCompactItems(msgs);
    expect(items.map((i: CompactItem) => i.kind)).toEqual(['single', 'group', 'single']);
  });
});
