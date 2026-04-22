import { describe, it, expect } from 'vitest';
import type { ClaudeStreamMessage } from '@/components/AgentExecution';
import { detectSkillInjection } from '../skillDetection';

function userText(text: string): ClaudeStreamMessage {
  return { type: 'user', message: { content: [{ type: 'text', text }] } } as ClaudeStreamMessage;
}

function skillToolUse(id: string, skill: string): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }],
      stop_reason: 'tool_use',
    },
  } as unknown as ClaudeStreamMessage;
}

function readToolUse(id: string): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/a' } }],
      stop_reason: 'tool_use',
    },
  } as unknown as ClaudeStreamMessage;
}

function toolResult(toolUseId: string, content: string): ClaudeStreamMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  } as unknown as ClaudeStreamMessage;
}

describe('detectSkillInjection', () => {
  it('returns null for a real user-typed message', () => {
    const msg = userText('hello');
    const all = [msg];
    expect(detectSkillInjection(msg, all)).toBeNull();
  });

  it('detects a user text message that follows a Skill tool_result', () => {
    const tu = skillToolUse('tu_1', 'work-on-ticket');
    const tr = toolResult('tu_1', 'Launching skill: work-on-ticket');
    const skillBody = userText('# Work On Ticket\n\nDo stuff.');
    const all = [userText('/work-on-ticket ws-117'), tu, tr, skillBody];
    expect(detectSkillInjection(skillBody, all)).toEqual({ skillName: 'work-on-ticket' });
  });

  it('returns null when the preceding tool_result is not for a Skill tool_use', () => {
    const tu = readToolUse('tu_1');
    const tr = toolResult('tu_1', 'file contents');
    const msg = userText('thanks');
    const all = [userText('read the file'), tu, tr, msg];
    expect(detectSkillInjection(msg, all)).toBeNull();
  });

  it('returns null when the message is not immediately preceded by a tool_result', () => {
    const msg = userText('# Something');
    const all = [userText('first'), msg];
    expect(detectSkillInjection(msg, all)).toBeNull();
  });

  it('returns null when the message has tool_result content', () => {
    const tu = skillToolUse('tu_1', 'foo');
    const tr = toolResult('tu_1', 'Launching skill: foo');
    expect(detectSkillInjection(tr, [tu, tr])).toBeNull();
  });

  it('falls back to "unknown" when the Skill tool_use lacks input.skill', () => {
    const tu = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'Skill', input: {} }],
        stop_reason: 'tool_use',
      },
    } as unknown as ClaudeStreamMessage;
    const tr = toolResult('tu_1', 'Launching skill: ?');
    const skillBody = userText('# Something');
    expect(detectSkillInjection(skillBody, [tu, tr, skillBody])).toEqual({ skillName: 'unknown' });
  });
});
