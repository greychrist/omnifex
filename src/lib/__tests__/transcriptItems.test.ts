import { describe, it, expect } from 'vitest';
import { classifyJsonlLine } from '@/lib/jsonlClassifier';
import { normalizeJsonlNode } from '@/lib/normalizeMessage';
import { createDefaultConfig, mergeConfig } from '@/lib/messageRenderingConfig';
import { transcriptItems } from '@/lib/transcriptItems';
import { ALL_KIND_RECORDS, KIND_OF_RECORD, drawnUuids, idOf } from './fixtures/allKindRecords';
import { GREG_RENDERING_CONFIG } from './fixtures/gregRenderingConfig';


// Expanded exists so Greg can check every record type is accounted for: it
// draws every record, whatever the per-kind settings say.
// A record whose content another item shows rather than a row of its own:
// a thought's token estimate is printed on the thought.
const FOLDED_INTO_ANOTHER = new Set(['system.thinking_tokens']);

describe('transcriptItems — Expanded', () => {
  it.each([['default', createDefaultConfig()], ["Greg's", mergeConfig(GREG_RENDERING_CONFIG)]])('draws every record (%s config)', (_, cfg) => {
    const drawn = new Set(drawnUuids(transcriptItems(ALL_KIND_RECORDS, cfg, 'expanded')));
    const missing = ALL_KIND_RECORDS.filter((n) => !drawn.has(idOf(n)!) && !FOLDED_INTO_ANOTHER.has(KIND_OF_RECORD.get(n)!));
    expect(missing.map(idOf)).toEqual([]);
  });

  it('still folds tool runs into work', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 10, 18, 9, 0, s)).toISOString();
    const recs = [
      { type: 'user', uuid: 'p', timestamp: at(0), message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
      { type: 'assistant', uuid: 'a1', timestamp: at(1), message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
      { type: 'user', uuid: 'r1', timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'assistant', uuid: 'a2', timestamp: at(3), message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }] } },
      { type: 'user', uuid: 'r2', timestamp: at(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } },
      { type: 'assistant', uuid: 'a3', timestamp: at(5), message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
    ].map((r) => normalizeJsonlNode(classifyJsonlLine(r)!));
    expect(transcriptItems(recs, createDefaultConfig(), 'expanded').map((i) => i.kind)).toEqual(['prompt', 'work', 'text']);
  });
});
