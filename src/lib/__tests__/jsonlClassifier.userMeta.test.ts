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
