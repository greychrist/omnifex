import { describe, it, expect } from 'vitest';
import { classifyJsonlLine } from '@/lib/jsonlClassifier';

describe('classifyUser — userKind discrimination', () => {
  it('classifies plain text content as prompt', () => {
    const node = classifyJsonlLine({
      type: 'user',
      sessionId: 's1',
      timestamp: '2026-05-26T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') expect(node.userKind).toBe('prompt');
  });

  it('classifies all-tool_result content as tool-result', () => {
    const node = classifyJsonlLine({
      type: 'user',
      sessionId: 's1',
      timestamp: '2026-05-26T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    });
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') expect(node.userKind).toBe('tool-result');
  });

  it('classifies isMeta + sourceToolUseID as meta-skill', () => {
    const node = classifyJsonlLine({
      type: 'user',
      sessionId: 's1',
      timestamp: '2026-05-26T00:00:00.000Z',
      isMeta: true,
      sourceToolUseID: 'toolu_abc',
      message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /x' }] },
    });
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') expect(node.userKind).toBe('meta-skill');
  });

  it('classifies isMeta + image marker as meta-attachment', () => {
    const node = classifyJsonlLine({
      type: 'user',
      sessionId: 's1',
      timestamp: '2026-05-26T00:00:00.000Z',
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: '[Image: original 100x100 …]' }] },
    });
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') expect(node.userKind).toBe('meta-attachment');
  });

  it('classifies isMeta with neither marker as meta-other', () => {
    const node = classifyJsonlLine({
      type: 'user',
      sessionId: 's1',
      timestamp: '2026-05-26T00:00:00.000Z',
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: 'arbitrary harness injection' }] },
    });
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') expect(node.userKind).toBe('meta-other');
  });

  it('tool-result takes precedence over isMeta', () => {
    const node = classifyJsonlLine({
      type: 'user',
      sessionId: 's1',
      timestamp: '2026-05-26T00:00:00.000Z',
      isMeta: true,
      sourceToolUseID: 'toolu_xyz',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    });
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') expect(node.userKind).toBe('tool-result');
  });
});

describe('classifyJsonlLine — local-command envelope', () => {
  const TS = '2026-09-16T15:05:25.269Z';

  // Both halves persist as plain `user` records with no isMeta, so they used
  // to classify as 'prompt' — a question the model never sees and will never
  // answer, which held the turn axis open forever (work session 3445e547).
  it('classifies a slash-command echo as local-command', () => {
    const node = classifyJsonlLine({
      type: 'user',
      timestamp: TS,
      message: {
        role: 'user',
        content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>',
      },
    });
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') expect(node.userKind).toBe('local-command');
  });

  it('classifies local-command stdout as local-command', () => {
    const node = classifyJsonlLine({
      type: 'user',
      timestamp: TS,
      message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' },
    });
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') expect(node.userKind).toBe('local-command');
  });

  // The live stream hands the same record over as content blocks rather than
  // a bare string; one shape must not classify differently from the other.
  it('detects the envelope in block-array content too', () => {
    const node = classifyJsonlLine({
      type: 'user',
      timestamp: TS,
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<command-name>/usage</command-name>' }],
      },
    });
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') expect(node.userKind).toBe('local-command');
  });

  // isMeta still wins: the caveat the CLI writes ahead of the echo is meta.
  it('leaves the local-command caveat as meta-other', () => {
    const node = classifyJsonlLine({
      type: 'user',
      timestamp: TS,
      isMeta: true,
      message: { role: 'user', content: '<local-command-caveat>Caveat: …</local-command-caveat>' },
    });
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') expect(node.userKind).toBe('meta-other');
  });

  it('leaves an ordinary typed prompt as prompt', () => {
    const node = classifyJsonlLine({
      type: 'user',
      timestamp: TS,
      message: { role: 'user', content: 'run the tests please' },
    });
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') expect(node.userKind).toBe('prompt');
  });
});

describe('classifyJsonlLine — unknown fallback', () => {
  it('returns kind: unknown for an unrecognized top-level type', () => {
    const node = classifyJsonlLine({
      type: 'mystery',
      timestamp: '2026-05-26T00:00:00.000Z',
      message: { foo: 'bar' },
    });
    expect(node?.kind).toBe('unknown');
  });

  it('returns kind: unknown for a known type with unrecognized subtype', () => {
    const node = classifyJsonlLine({
      type: 'system',
      subtype: 'never_seen_subtype',
      timestamp: '2026-05-26T00:00:00.000Z',
    });
    expect(node?.kind).toBe('unknown');
  });

  it('still returns null for completely malformed input', () => {
    expect(classifyJsonlLine(null)).toBeNull();
    expect(classifyJsonlLine('not-an-object')).toBeNull();
    expect(classifyJsonlLine({ /* missing type */ })).toBeNull();
  });
});
