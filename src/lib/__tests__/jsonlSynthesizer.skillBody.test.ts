import { describe, it, expect } from 'vitest';
import { classifyJsonlLine } from '@/lib/jsonlClassifier';
import { synthesizeBatch } from '@/lib/jsonlSynthesizer';

describe('synthesizer — skill-body injection regression', () => {
  it('does NOT emit a synthesized-result when a meta-skill user follows a tool_use assistant', () => {
    // Mirrors the JSONL we captured from the morning's release session:
    // user.prompt → assistant(text + tool_use:Skill) → user(tool_result) → user(meta-skill text) → assistant(continuation) → ...
    // The bug was that the meta-skill text was classified as user.prompt, which
    // triggered flushPending() against the prior assistant message and synthesized
    // a result with subtype 'error_during_execution'.
    // With Task 1.2's fix, meta-skill is classified correctly and does NOT trigger
    // the false flush.
    const lines = [
      {
        type: 'user',
        sessionId: 's1',
        timestamp: '2026-05-26T15:01:02.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'commit and push, then /omnifex-release' }] },
      },
      {
        type: 'assistant',
        sessionId: 's1',
        timestamp: '2026-05-26T15:01:22.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Committed and pushed. Now invoking the release skill.' },
            { type: 'tool_use', id: 'toolu_skill', name: 'Skill', input: { skill: 'omnifex-release' } },
          ],
          stop_reason: 'tool_use',
        },
      },
      {
        type: 'user',
        sessionId: 's1',
        timestamp: '2026-05-26T15:01:23.440Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_skill', content: '' }] },
      },
      {
        type: 'user',
        sessionId: 's1',
        timestamp: '2026-05-26T15:01:23.439Z',
        isMeta: true,
        sourceToolUseID: 'toolu_skill',
        message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /x\n# OmniFex Release' }] },
      },
      {
        type: 'assistant',
        sessionId: 's1',
        timestamp: '2026-05-26T15:01:35.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Release completed successfully.' },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 200, output_tokens: 100 },
        },
      },
    ];

    const nodes = lines
      .map((l) => classifyJsonlLine(l))
      .filter((n): n is NonNullable<typeof n> => n !== null);

    const out = synthesizeBatch(nodes);
    const synthesizedResults = out.filter((n) => n.kind === 'synthesized-result');
    
    // After the turn properly terminates with the second assistant message,
    // the synthesizer should emit exactly one synthesized-result for that turn.
    // The presence of the meta-skill message should NOT cause an extra phantom result.
    expect(synthesizedResults).toHaveLength(1);
    if (synthesizedResults[0].kind === 'synthesized-result') {
      expect(synthesizedResults[0].isError).toBe(false);
      expect(synthesizedResults[0].subtype).toBe('success');
    }
  });
});
