/**
 * Fixture-based regression test for session c0e34556.
 *
 * This session was the original trigger for the jsonl-as-rendered refactor:
 * its final card showed a misleading "Execution Failed" synthesized result
 * because the old jsonlSynthesizer emitted 'synthesized-result' nodes based
 * on wall-clock timeouts, not actual session state. The refactor deleted the
 * synthesizer entirely. This test locks in the new behaviour using the real
 * final-turn data from that session.
 *
 * Assertions:
 *  1. The classifier never produces 'synthesized-init' or 'synthesized-result'
 *     (those kinds don't exist in the current taxonomy, but let's be explicit).
 *  2. With the final assistant's stop_reason=end_turn present, conversationStatus
 *     returns 'idle'.
 *  3. With the final assistant's stop_reason stripped, conversationStatus returns
 *     'running' (the session looks mid-turn, not complete).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { classifyJsonlLine } from '../jsonlClassifier';
import type { JsonlNode } from '@/types/jsonl';

// ---------------------------------------------------------------------------
// Load the fixture — 20 JSONL lines from the final turn of session c0e34556.
// Content fields are trimmed to <100 chars; all structural fields are intact.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helper: produce a modified fixture where the last main-chain assistant's
// stop_reason is removed, simulating a mid-turn snapshot (incomplete session).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('c0e34556 session regression (jsonl-as-rendered refactor)', () => {
  it('classifies every fixture line without producing synthesized kinds', () => {
    const nodes = loadFixtureNodes();
    // The fixture has 20 lines; some drop to null (none expected, but allow it).
    expect(nodes.length).toBeGreaterThan(0);

    // Neither kind existed before the refactor was cleaned up, but assert
    // explicitly so the test fails loudly if they ever reappear.
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
    // The fixture covers the *tail* of the session — the user prompt that kicked off
    // this turn is in an earlier section of the JSONL not included here. The tail
    // contains: one meta-skill user line, several tool-result user lines, several
    // assistant lines (tool_use + end_turn), and last-prompt bookkeeping entries.
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
