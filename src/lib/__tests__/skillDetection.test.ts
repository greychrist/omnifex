import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { detectSkillInjection } from '../skillDetection';

function userText(text: string): JsonlNode {
  return { kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '', raw: { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } } } as unknown as JsonlNode;
}

function skillToolUse(id: string, skill: string): JsonlNode {
  return {
    kind: 'assistant', sessionId: '', receivedAt: '',
    raw: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }],
        stop_reason: 'tool_use',
      },
    },
  } as unknown as JsonlNode;
}

function readToolUse(id: string): JsonlNode {
  return {
    kind: 'assistant', sessionId: '', receivedAt: '',
    raw: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/a' } }],
        stop_reason: 'tool_use',
      },
    },
  } as unknown as JsonlNode;
}

/**
 * A skill companion record as the CLI persists it: text content, `isMeta`,
 * and `sourceToolUseID` naming the Skill tool_use that produced it. This is
 * the shape the JSONL always carries — stream-json strips all three.
 */
function skillCompanion(sourceToolUseID: string, text: string): JsonlNode {
  return {
    kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '',
    raw: {
      type: 'user',
      isMeta: true,
      turnCompanion: true,
      sourceToolUseID,
      message: { role: 'user', content: [{ type: 'text', text }] },
    },
  } as unknown as JsonlNode;
}

function toolResult(toolUseId: string, content: string): JsonlNode {
  return {
    kind: 'user', userKind: 'tool-result', sessionId: '', receivedAt: '',
    raw: {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
    },
  } as unknown as JsonlNode;
}

describe('detectSkillInjection', () => {
  it('returns null for a real user-typed message', () => {
    const msg = userText('hello');
    const all = [msg];
    expect(detectSkillInjection(msg, all)).toBeNull();
  });

  it('detects the sole companion of a first invocation', () => {
    const tu = skillToolUse('tu_1', 'work-on-ticket');
    const tr = toolResult('tu_1', 'Launching skill: work-on-ticket');
    const skillBody = skillCompanion('tu_1', '# Work On Ticket\n\nDo stuff.');
    const all = [userText('/work-on-ticket ws-117'), tu, tr, skillBody];
    expect(detectSkillInjection(skillBody, all)).toEqual({ skillName: 'work-on-ticket' });
  });

  it('returns null when sourceToolUseID names a tool other than Skill', () => {
    const tu = readToolUse('tu_1');
    const tr = toolResult('tu_1', 'file contents');
    const msg = skillCompanion('tu_1', 'thanks');
    const all = [userText('read the file'), tu, tr, msg];
    expect(detectSkillInjection(msg, all)).toBeNull();
  });

  it('returns null for a user message carrying no sourceToolUseID', () => {
    // A message the user actually typed. This is the case that regressed:
    // it must never be mistaken for a skill body, and a skill body must
    // never be mistaken for it.
    const msg = userText('# Something');
    const all = [userText('first'), msg];
    expect(detectSkillInjection(msg, all)).toBeNull();
  });

  it('returns null when sourceToolUseID matches no tool_use in the transcript', () => {
    const msg = skillCompanion('tu_missing', '# Orphaned body');
    const all = [userText('first'), msg];
    expect(detectSkillInjection(msg, all)).toBeNull();
  });

  it('detects the preamble as well as the body, since both name the Skill call', () => {
    const tu = skillToolUse('tu_1', 'commit');
    const tr = toolResult('tu_1', 'Launching skill: commit');
    const preamble = skillCompanion('tu_1', '(Re-invocation of /commit — …)');
    const body = skillCompanion('tu_1', '# Commit\n\n…');
    const all = [tu, tr, preamble, body];
    expect(detectSkillInjection(preamble, all)).toEqual({ skillName: 'commit' });
    expect(detectSkillInjection(body, all)).toEqual({ skillName: 'commit' });
  });

  it('returns null when the message has tool_result content', () => {
    const tu = skillToolUse('tu_1', 'foo');
    const tr = toolResult('tu_1', 'Launching skill: foo');
    expect(detectSkillInjection(tr, [tu, tr])).toBeNull();
  });

  // Regression: CLI 2.1.270 emits TWO companion records when a skill is
  // re-invoked in one session — a short "(Re-invocation of …)" preamble, then
  // the SKILL.md body. Adjacency matched the preamble, so the body fell
  // through to `user.prompt` and rendered as if the user had typed the whole
  // skill. Both records name their originating tool_use in `sourceToolUseID`.
  // Captured from WIN session 25d0800c-c395-4477-b78f-ca3f54945135.
  it('detects the body when a re-invocation preamble sits between it and the tool_result', () => {
    const tu = skillToolUse('toolu_011V4gwJ', 'commit');
    const tr = toolResult('toolu_011V4gwJ', 'Launching skill: commit');
    const preamble = skillCompanion(
      'toolu_011V4gwJ',
      '(Re-invocation of /commit — the skill instructions were previously loaded; the arguments or dynamic output below are new.)',
    );
    const body = skillCompanion('toolu_011V4gwJ', '# Commit\n\nUse this command when…');
    const all = [userText('yes commit and push'), tu, tr, preamble, body];
    expect(detectSkillInjection(body, all)).toEqual({ skillName: 'commit' });
  });

  it('falls back to "unknown" when the Skill tool_use lacks input.skill', () => {
    const tu = {
      kind: 'assistant', sessionId: '', receivedAt: '',
      raw: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'Skill', input: {} }],
          stop_reason: 'tool_use',
        },
      },
    } as unknown as JsonlNode;
    const tr = toolResult('tu_1', 'Launching skill: ?');
    const skillBody = skillCompanion('tu_1', '# Something');
    expect(detectSkillInjection(skillBody, [tu, tr, skillBody])).toEqual({ skillName: 'unknown' });
  });
});
