import { describe, it, expect } from 'vitest';
import type { ClaudeStreamMessage } from '@/types/claudeStream';
import { buildCompactItems, isBoundaryMessage, type CompactItem } from '../compactGrouping';
import { createDefaultConfig } from '../messageRenderingConfig';

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

function toolResultMsg(toolUseId = 'tu_x'): ClaudeStreamMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
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

  it('treats subagent prompts (user text with parent_tool_use_id) as non-boundary', () => {
    const subagent = {
      ...userText('Investigate the auth middleware'),
      parent_tool_use_id: 'tu_parent',
    } as ClaudeStreamMessage;
    expect(isBoundaryMessage(subagent)).toBe(false);
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

  it('promotes standalone kinds to singles when hiddenInCompact=false in config', () => {
    const sysInit = {
      type: 'system',
      subtype: 'init',
      session_id: 'abc',
      model: 'claude',
      cwd: '/x',
      tools: [],
    } as unknown as ClaudeStreamMessage;
    const cfg = createDefaultConfig();
    cfg.kinds['system.init'] = { ...cfg.kinds['system.init'], hiddenInCompact: false };
    const msgs = [
      userText('hi'),
      sysInit,
      toolUseMsg('Read', { file_path: '/a' }),
      toolResultMsg(),
      assistantEndTurn('done'),
    ];
    const items = buildCompactItems(msgs, cfg);
    // user(single) + sysInit(single, promoted) + group(Read+result) + assistant(single)
    expect(items.map((i: CompactItem) => i.kind)).toEqual(['single', 'single', 'group', 'single']);
    const promoted = items[1];
    expect(promoted.kind).toBe('single');
    if (promoted.kind === 'single') {
      expect(promoted.message).toBe(sysInit);
    }
  });

  it('keeps standalone kinds inside groups when no config is passed (back-compat)', () => {
    const sysInit = {
      type: 'system',
      subtype: 'init',
      session_id: 'abc',
      model: 'claude',
      cwd: '/x',
      tools: [],
    } as unknown as ClaudeStreamMessage;
    const msgs = [
      userText('hi'),
      sysInit,
      toolUseMsg('Read', { file_path: '/a' }),
      toolResultMsg(),
      assistantEndTurn('done'),
    ];
    const items = buildCompactItems(msgs);
    // Without config: sysInit stays in the group with the tool_use/result.
    expect(items.map((i: CompactItem) => i.kind)).toEqual(['single', 'group', 'single']);
  });

  it('collapses skill-injected user messages into the preceding group', () => {
    const skillTU = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tu_skill', name: 'Skill', input: { skill: 'foo' } }],
        stop_reason: 'tool_use',
      },
    } as unknown as ClaudeStreamMessage;
    const skillBody = userText('# Foo\n\nDo a thing.');
    const msgs = [
      userText('/foo'),
      skillTU,
      toolResultMsg('tu_skill'),
      skillBody,
      assistantEndTurn('ok'),
    ];
    const items = buildCompactItems(msgs);
    // real user(single) + group(Skill TU + result + skill body) + assistant(single)
    expect(items.map((i: CompactItem) => i.kind)).toEqual(['single', 'group', 'single']);
    const group = items[1];
    if (group.kind === 'group') {
      expect(group.messages).toContain(skillBody);
      expect(group.messages.length).toBe(3);
    }
  });
});
