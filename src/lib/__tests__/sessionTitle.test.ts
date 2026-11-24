import { describe, it, expect } from 'vitest';
import { pickSessionTitle, deriveSessionTitle, firstPromptText } from '../sessionTitle';
import type { JsonlNode } from '@/types/jsonl';

const aiTitle = (aiTitle: string): JsonlNode =>
  ({ kind: 'ai-title', raw: { type: 'ai-title', aiTitle }, sessionId: 's' }) as unknown as JsonlNode;

const customTitle = (customTitle: string): JsonlNode =>
  ({ kind: 'custom-title', raw: { type: 'custom-title', customTitle }, sessionId: 's' }) as unknown as JsonlNode;

describe('pickSessionTitle', () => {
  // The CLI lets a rename win whichever record was written last.
  it('prefers a rename over the CLI’s own generated title', () => {
    expect(pickSessionTitle({ aiTitle: 'Generated', customTitle: 'Renamed' })).toBe('Renamed');
  });

  it('falls back to the generated title when there is no rename', () => {
    expect(pickSessionTitle({ aiTitle: 'Generated' })).toBe('Generated');
  });

  it('returns null when the session has neither', () => {
    expect(pickSessionTitle({})).toBeNull();
  });

  // The CLI clears a custom title by writing `customTitle: ""`.
  it('treats a blank rename as no rename', () => {
    expect(pickSessionTitle({ aiTitle: 'Generated', customTitle: '   ' })).toBe('Generated');
  });

  it('trims what it returns', () => {
    expect(pickSessionTitle({ customTitle: '  Renamed  ' })).toBe('Renamed');
  });
});

describe('deriveSessionTitle', () => {
  it('reads the title out of the transcript the CLI wrote', () => {
    expect(deriveSessionTitle([aiTitle('Generated')])).toBe('Generated');
  });

  it('takes the last record of each type', () => {
    expect(deriveSessionTitle([aiTitle('First guess'), aiTitle('Settled on')])).toBe('Settled on');
  });

  it('keeps a rename even when an ai-title is appended after it', () => {
    const messages = [aiTitle('Generated'), customTitle('Renamed'), aiTitle('Generated')];
    expect(deriveSessionTitle(messages)).toBe('Renamed');
  });

  it('returns null for a transcript with no title records', () => {
    expect(deriveSessionTitle([])).toBeNull();
  });
});

describe('firstPromptText', () => {
  const user = (content: unknown, extra: Record<string, unknown> = {}): JsonlNode =>
    ({ kind: 'user', userKind: 'prompt', sessionId: 's', receivedAt: '', raw: { type: 'user', message: { role: 'user', content }, ...extra } } as unknown as JsonlNode);

  it('returns the first main prompt, joining its text blocks', () => {
    const msgs = [
      { kind: 'cli-stream-init', sessionId: 's', receivedAt: '', raw: {} } as unknown as JsonlNode,
      user([{ type: 'text', text: 'How often ' }, { type: 'image', source: {} }, { type: 'text', text: 'should I water?' }]),
      user('a later prompt'),
    ];
    expect(firstPromptText(msgs)).toBe('How often should I water?');
  });

  it('accepts string content', () => {
    expect(firstPromptText([user('plain string prompt')])).toBe('plain string prompt');
  });

  it('skips tool results and forwarded subagent prompts, and returns null with no prompt', () => {
    const toolResult = { kind: 'user', userKind: 'tool-result', sessionId: 's', receivedAt: '', raw: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } } } as unknown as JsonlNode;
    const forwarded = user('subagent prompt', { parent_tool_use_id: 'toolu_1' });
    expect(firstPromptText([toolResult, forwarded])).toBeNull();
    expect(firstPromptText([toolResult, forwarded, user('the real one')])).toBe('the real one');
    expect(firstPromptText([])).toBeNull();
  });

  it('reads a command echo as the command that was typed', () => {
    expect(firstPromptText([user('<command-message>timesheet-review</command-message>\n<command-name>/timesheet-review</command-name>')]))
      .toBe('/timesheet-review');
    expect(firstPromptText([user('<command-message>work-on-ticket</command-message>\n<command-name>/work-on-ticket</command-name>\n<command-args>WIN-12</command-args>')]))
      .toBe('/work-on-ticket WIN-12');
  });
});
