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
import { KIND_REGISTRY, mergeConfig, type MessageRenderingConfig } from '@/lib/messageRenderingConfig';
import { classifyStandaloneKind } from '@/lib/messageKind';
import { transcriptItems } from '@/lib/transcriptItems';
import { ALL_KIND_RECORDS, KIND_OF_RECORD, NOT_A_RECORD, drawnUuids } from './fixtures/allKindRecords';
import { GREG_RENDERING_CONFIG } from './fixtures/gregRenderingConfig';

/** Kinds decided per content block, not by classifyStandaloneKind. */
const BLOCK_LEVEL = new Set([
  'assistant.text', 'assistant.text.endTurn', 'assistant.thinking', 'assistant.tool-use',
  'assistant.askUserQuestion', 'user.prompt', 'user.tool-result', 'user.tool-result.image',
  'user.image', 'user.compactSummary', 'user.sdkSystemBracket',
]);

/**
 * A saved v5 config, loaded the way the app loads one. The goldens drive
 * Standard through `mergeConfig`, so after the v6 config they exercise the
 * migration: what an old saved setting showed is what Standard shows.
 */
const savedV5 = (rules: 'compact' | 'verbose' | 'all', kinds: Record<string, Record<string, unknown>> = {}): MessageRenderingConfig =>
  mergeConfig({ version: 5, kinds, modern: { recordRules: rules } });

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
    expect(drawnUuids(transcriptItems(ALL_KIND_RECORDS, savedV5(rules), 'standard'))).toMatchSnapshot();
  });

  it("Greg's saved config", () => {
    expect(drawnUuids(transcriptItems(ALL_KIND_RECORDS, mergeConfig(GREG_RENDERING_CONFIG), 'standard'))).toMatchSnapshot();
  });
});

// Each kind set to Verbose and to Never, one at a time, under each record
// rule. Pins the two ways the old settings hid a kind — a line Compact hid,
// a record Never dropped — which the v6 migration has to reproduce for every
// kind separately (Modern draws thinking, tool calls and answers as its own
// items, which Verbose never hid).
describe('what Standard draws per kind setting (golden — never update with -u)', () => {
  const kinds = Object.keys(KIND_REGISTRY);
  for (const rules of ['compact', 'verbose'] as const) {
    for (const visibility of ['verbose', 'never'] as const) {
      it(`every kind set to ${visibility}, one at a time, recordRules ${rules}`, () => {
        // Only what differs from the rule's baseline, so the snapshot reads
        // as "setting this kind hid these records".
        const base = new Set(drawnUuids(transcriptItems(ALL_KIND_RECORDS, savedV5(rules), 'standard')));
        const changed: Record<string, { hidden: string[]; shown: string[] }> = {};
        for (const id of kinds) {
          const cfg = savedV5(rules, { [id]: { visibility } });
          const drawn = drawnUuids(transcriptItems(ALL_KIND_RECORDS, cfg, 'standard'));
          const now = new Set(drawn);
          const hidden = [...base].filter((u) => !now.has(u));
          const shown = drawn.filter((u) => !base.has(u));
          if (hidden.length || shown.length) changed[id] = { hidden, shown };
        }
        expect(changed).toMatchSnapshot();
      });
    }
  }
});
