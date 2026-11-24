import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { classifyJsonlLine } from '../jsonlClassifier';
import type { JsonlNode } from '@/types/jsonl';

// 20 JSONL lines from a session's final turn; content trimmed, structure intact.

const FIXTURE_PATH = join(__dirname, 'fixtures', 'c0e34556-final-turn.jsonl');

function loadFixtureNodes(): JsonlNode[] {
  const raw = readFileSync(FIXTURE_PATH, 'utf8');
  const nodes: JsonlNode[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as unknown;
    const node = classifyJsonlLine(parsed);
    if (node !== null) nodes.push(node);
  }
  return nodes;
}

// The last main-chain assistant's stop_reason removed: a mid-turn snapshot.

describe('c0e34556 session regression (jsonl-as-rendered refactor)', () => {
  it('classifies every fixture line without producing synthesized kinds', () => {
    const nodes = loadFixtureNodes();
    expect(nodes.length).toBeGreaterThan(0);

    for (const node of nodes) {
      expect(node.kind).not.toBe('synthesized-init');
      expect(node.kind).not.toBe('synthesized-result');
    }
  });

  it('classifies all fixture lines into known taxonomy kinds', () => {
    const VALID_KINDS = new Set([
      'assistant', 'user', 'attachment', 'unknown',
      'queue-operation', 'last-prompt', 'permission-mode',
      'ai-title', 'file-history-snapshot', 'system',
      'cli-stream-init', 'cli-stream-result',
      'stream-event', 'rate-limit', 'lifecycle',
    ]);
    const nodes = loadFixtureNodes();
    for (const node of nodes) {
      expect(VALID_KINDS.has(node.kind)).toBe(true);
    }
  });

  it('fixture contains the expected structural shape: meta-skill, tool-results, and assistants', () => {
    // The fixture is the session's tail: the turn's prompt is not in it.
    const nodes = loadFixtureNodes();
    const metaSkill = nodes.filter((n) => n.kind === 'user' && n.userKind === 'meta-skill');
    const toolResults = nodes.filter((n) => n.kind === 'user' && n.userKind === 'tool-result');
    const assistants = nodes.filter((n) => n.kind === 'assistant');
    const lastPrompts = nodes.filter((n) => n.kind === 'last-prompt');
    expect(metaSkill.length).toBeGreaterThanOrEqual(1);
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect(assistants.length).toBeGreaterThanOrEqual(2); // at least one tool_use + one end_turn
    expect(lastPrompts.length).toBeGreaterThanOrEqual(1);
  });
});
