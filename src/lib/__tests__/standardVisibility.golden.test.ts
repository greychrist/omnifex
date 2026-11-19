/**
 * What the chat draws, pinned. Written against the Modern pipeline as it was
 * on 2026-11-18, before Standard and Expanded replaced the four formats.
 *
 * Greg's rule: what Modern shows today is what Standard shows afterwards,
 * whatever the old Compact/Verbose settings said. So this snapshot is NEVER
 * regenerated with `-u`. A change that alters it has changed what Standard
 * shows; fix the change, not the snapshot.
 */
import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { KIND_REGISTRY, createDefaultConfig, mergeConfig, type MessageRenderingConfig } from '@/lib/messageRenderingConfig';
import { classifyStandaloneKind } from '@/lib/messageKind';
import type { ModernItem } from '@/lib/modernGrouping';
import { transcriptItems } from '@/lib/transcriptItems';
import { ALL_KIND_RECORDS, KIND_OF_RECORD, NOT_A_RECORD } from './fixtures/allKindRecords';
import { GREG_RENDERING_CONFIG } from './fixtures/gregRenderingConfig';

/** Kinds decided per content block, not by classifyStandaloneKind. */
const BLOCK_LEVEL = new Set([
  'assistant.text', 'assistant.text.endTurn', 'assistant.thinking', 'assistant.tool-use',
  'assistant.askUserQuestion', 'user.prompt', 'user.tool-result', 'user.tool-result.image',
  'user.image', 'user.compactSummary', 'user.sdkSystemBracket',
]);

function idOf(n: JsonlNode | undefined): string | null {
  if (!n) return null;
  const uuid = (n as { raw?: { uuid?: unknown } }).raw?.uuid;
  return typeof uuid === 'string' ? uuid : `${n.kind}@${(n as { receivedAt?: string }).receivedAt ?? ''}`;
}

/** Every record an item draws, work entries included, in order. */
export function drawnUuids(items: ModernItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const i = item as { node?: JsonlNode; nodes?: JsonlNode[]; resultNode?: JsonlNode; summaryNode?: JsonlNode };
    for (const n of [i.node, ...(i.nodes ?? []), i.resultNode, i.summaryNode]) {
      const id = idOf(n);
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

const withRules = (rules: 'compact' | 'verbose' | 'all'): MessageRenderingConfig => {
  const cfg = createDefaultConfig();
  return { ...cfg, modern: { ...cfg.modern, recordRules: rules } };
};

describe('the all-kinds fixture', () => {
  it('covers every registry kind a record can produce', () => {
    const covered = new Set(KIND_OF_RECORD.values());
    const missing = Object.keys(KIND_REGISTRY).filter((id) => !covered.has(id) && !NOT_A_RECORD.has(id));
    expect(missing).toEqual([]);
  });

  it('classifies each standalone record as the kind it was written for', () => {
    const wrong = ALL_KIND_RECORDS
      // modernLineOf reads a null as `unknown`, so the test does too.
      .map((n) => [KIND_OF_RECORD.get(n)!, classifyStandaloneKind(n, ALL_KIND_RECORDS) ?? 'unknown'] as const)
      .filter(([want, got]) => !BLOCK_LEVEL.has(want) && !want.startsWith('control.') && got !== want);
    expect(wrong).toEqual([]);
  });
});

describe('what Standard draws (golden — never update with -u)', () => {
  it.each(['compact', 'verbose', 'all'] as const)('default config, recordRules %s', (rules) => {
    expect(drawnUuids(transcriptItems(ALL_KIND_RECORDS, withRules(rules), 'modern'))).toMatchSnapshot();
  });

  it("Greg's saved config", () => {
    expect(drawnUuids(transcriptItems(ALL_KIND_RECORDS, mergeConfig(GREG_RENDERING_CONFIG), 'modern'))).toMatchSnapshot();
  });
});
