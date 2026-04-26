import { describe, it, expect } from 'vitest';
import type { ClaudeStreamMessage } from '@/types/claudeStream';
import { summarizeGroup } from '@/components/CollapsibleGroup';

function thinkingMsg(text: string): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: text, signature: 'sig' }] },
  } as unknown as ClaudeStreamMessage;
}

function toolUseMsg(name: string): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input: {} }] },
  } as unknown as ClaudeStreamMessage;
}

function emptyTextMsg(): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text: '' }] },
  } as unknown as ClaudeStreamMessage;
}

describe('summarizeGroup', () => {
  it('counts thinking blocks with content', () => {
    expect(summarizeGroup([thinkingMsg('Considering options')])).toBe('1 thought');
  });

  it('does not count signature-only (empty) thinking blocks', () => {
    // This was the "1 thought expander with nothing inside" bug — the renderer
    // skips empty thinking blocks, so the summary must skip them too.
    expect(summarizeGroup([thinkingMsg('')])).toBe('');
    expect(summarizeGroup([thinkingMsg('   ')])).toBe('');
  });

  it('describes tool uses with an action label', () => {
    const s = summarizeGroup([toolUseMsg('Read')]);
    expect(s).toContain('Read');
  });

  it('returns empty string when the group has no renderable content', () => {
    // "1 step" expander with nothing inside — same failure mode as the empty
    // thinking case, but coming from the fallback branch.
    expect(summarizeGroup([emptyTextMsg()])).toBe('');
  });

  it('combines multiple thinking blocks', () => {
    expect(summarizeGroup([thinkingMsg('a'), thinkingMsg('b')])).toBe('2 thoughts');
  });
});
