import { describe, it, expect } from 'vitest';
import type { ClaudeStreamMessage } from '@/types/claudeStream';
import { filterDisplayableMessages } from '../messageFilters';

const userImage = (): ClaudeStreamMessage =>
  ({
    type: 'user',
    message: {
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
        },
      ],
    },
  } as unknown as ClaudeStreamMessage);

const userTextAndImage = (): ClaudeStreamMessage =>
  ({
    type: 'user',
    message: {
      content: [
        { type: 'text', text: 'look at this' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
        },
      ],
    },
  } as unknown as ClaudeStreamMessage);

const userText = (text: string): ClaudeStreamMessage =>
  ({ type: 'user', message: { content: [{ type: 'text', text }] } } as unknown as ClaudeStreamMessage);

describe('filterDisplayableMessages', () => {
  it('keeps user messages with text only', () => {
    const out = filterDisplayableMessages([userText('hello')]);
    expect(out).toHaveLength(1);
  });

  it('keeps user messages with text + image', () => {
    const out = filterDisplayableMessages([userTextAndImage()]);
    expect(out).toHaveLength(1);
  });

  it('keeps user messages that contain only an image', () => {
    const out = filterDisplayableMessages([userImage()]);
    expect(out).toHaveLength(1);
  });

  describe('skill-injection isMeta exemption', () => {
    // The Claude Code CLI persists skill-body injections with isMeta:true,
    // which the SDK live-stream version emits as isSynthetic:true (no isMeta).
    // The filter must keep skill bodies visible even when isMeta is set —
    // otherwise the `Skill: <name>` card disappears after the renderer
    // reloads the session from JSONL.

    const skillToolUse = (id: string, skillName: string): ClaudeStreamMessage =>
      ({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: skillName } }] },
      } as unknown as ClaudeStreamMessage);

    const skillToolResult = (toolUseId: string, body = 'Launching skill: x'): ClaudeStreamMessage =>
      ({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: body }] },
      } as unknown as ClaudeStreamMessage);

    const skillBody = (text: string, isMeta = true): ClaudeStreamMessage =>
      ({
        type: 'user',
        isMeta,
        message: { content: [{ type: 'text', text }] },
      } as unknown as ClaudeStreamMessage);

    it('keeps an isMeta user message that is a skill injection', () => {
      const messages = [
        skillToolUse('toolu_x', 'merge-to-main'),
        skillToolResult('toolu_x'),
        skillBody('# Merge to Main\n\nRun the gate.', true),
      ];
      const out = filterDisplayableMessages(messages);
      expect(out).toHaveLength(3);
      // The skill body must be the last one
      const last = out[out.length - 1] as any;
      expect(last.isMeta).toBe(true);
      expect(last.message.content[0].text).toContain('# Merge to Main');
    });

    it('still drops an isMeta user message that is NOT a skill injection (e.g. plain meta noise)', () => {
      const messages = [
        skillBody('orphan meta with no preceding Skill tool', true),
      ];
      const out = filterDisplayableMessages(messages);
      expect(out).toHaveLength(0);
    });

    it('keeps a non-isMeta user message regardless of skill detection', () => {
      // Backstop: this is the live-stream shape (isSynthetic only). Already
      // passes today; lock it in so no future regression drops live skill
      // bodies before they hit the renderer.
      const messages = [
        skillToolUse('toolu_y', 'foo'),
        skillToolResult('toolu_y'),
        skillBody('# foo body', false),
      ];
      const out = filterDisplayableMessages(messages);
      expect(out).toHaveLength(3);
    });
  });
});
