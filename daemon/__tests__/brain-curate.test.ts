import { describe, expect, it } from 'vitest';
import {
  COOLDOWN_DAYS,
  MIN_DECISION_ENTRIES,
  MIN_TIMELINE_ENTRIES,
  RETAIN_RECENT,
  RETAIN_RECENT_DECISIONS,
  collapsibleDecisions,
  collapsibleEntries,
  curate,
  qualifies,
} from '../services/brain/curate';
import { serializeNote } from '../services/brain/frontmatter';
import type { ParsedNote } from '../services/brain/types';

/** A note with `count` dated Timeline entries, dated 2026-01-01 onward. */
function noteWith(count: number, extra: Partial<ParsedNote['frontmatter']> = {}): ParsedNote {
  const entries = Array.from({ length: count }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    return `- **2026-01-${day}**: Entry number ${String(i + 1)}.`;
  });
  return {
    frontmatter: {
      type: 'Subsystem',
      aliases: ['alpha'],
      keywords: ['beta'],
      created: '2026-01-01',
      updated: '2026-02-01',
      sources: ['session:a'],
      ...extra,
    },
    body: [
      '# Widget',
      '',
      '## Summary',
      'A widget.',
      '',
      '## Connected to',
      '- [[Projects/omnifex]] — belongs to',
      '',
      '## Timeline',
      ...entries,
      '',
      '## Decisions',
      '- **2026-01-02**: Chose the widget.',
      '',
      '## Key facts',
      '- Widgets are load-bearing.',
      '',
      '## Open items',
      '- Ask Greg about the flange.',
      '',
      '## Assistant notes',
      'Handle with care.',
      '',
    ].join('\n'),
  };
}

const RESULT = {
  collapsed: 'Early widget work: the flange was specified and then revised twice.',
  collapsedDecisions: 'Settled the flange material and the revision cadence.',
  promotedFacts: ['The flange is revised roughly monthly.'],
};

/**
 * A note carrying `count` dated Decisions and a short Timeline — the real shape
 * of the vault's biggest notes, where decisions outnumber timeline entries 3-5x
 * because a session yields one Timeline entry and several decisions.
 */
function decisionNote(
  count: number,
  timelineCount = 2,
  extra: Partial<ParsedNote['frontmatter']> = {},
): ParsedNote {
  const decisions = Array.from({ length: count }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    return `- **2026-03-${day}**: Decision number ${String(i + 1)}.`;
  });
  const timeline = Array.from({ length: timelineCount }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    return `- **2026-01-${day}**: Entry number ${String(i + 1)}.`;
  });
  return {
    frontmatter: {
      type: 'Subsystem',
      aliases: [],
      keywords: [],
      created: '2026-01-01',
      updated: '2026-04-01',
      sources: ['session:a'],
      ...extra,
    },
    body: [
      '# Widget',
      '',
      '## Summary',
      'A widget.',
      '',
      '## Timeline',
      ...timeline,
      '',
      '## Decisions',
      ...decisions,
      '',
      '## Key facts',
      '- Widgets are load-bearing.',
      '',
      '## Open items',
      '',
      '## Assistant notes',
      '',
    ].join('\n'),
  };
}

/** The non-blank lines of one rendered section. */
function sectionOf(body: string, name: string): string[] {
  const after = body.split(`## ${name}\n`)[1];
  if (after === undefined) return [];
  return after
    .split('\n## ')[0]
    .trim()
    .split('\n')
    .filter((line) => line.trim() !== '');
}

describe('qualifies', () => {
  it('is true for a long, never-curated note', () => {
    expect(qualifies(noteWith(MIN_TIMELINE_ENTRIES), '2026-03-01')).toBe(true);
  });

  it('is false below the entry threshold', () => {
    expect(qualifies(noteWith(MIN_TIMELINE_ENTRIES - 1), '2026-03-01')).toBe(false);
  });

  it('is false when nothing changed since the last curation', () => {
    const note = noteWith(20, { updated: '2026-02-01', curated_at: '2026-02-01' });
    expect(qualifies(note, '2026-06-01')).toBe(false);
  });

  it('is false inside the cooldown even when the note changed', () => {
    const note = noteWith(20, { updated: '2026-03-05', curated_at: '2026-03-01' });
    expect(qualifies(note, `2026-03-0${String(1 + COOLDOWN_DAYS - 1)}`)).toBe(false);
  });

  it('is true once the cooldown has elapsed and the note changed', () => {
    const note = noteWith(20, { updated: '2026-03-05', curated_at: '2026-03-01' });
    expect(qualifies(note, '2026-03-09')).toBe(true);
  });

  it('is false for a note with no Timeline section at all', () => {
    // This is the shape every translated auto-memory note has.
    const freeform: ParsedNote = {
      frontmatter: {
        type: 'Note',
        aliases: [],
        keywords: [],
        created: '2026-01-01',
        updated: '2026-02-01',
        sources: ['auto-memory:x/y.md'],
      },
      body: '## Summary\n\nA memory.\n\nSome prose.\n',
    };
    expect(qualifies(freeform, '2026-06-01')).toBe(false);
  });

  it('does not block forever on an unparseable curated_at', () => {
    const note = noteWith(20, { updated: '2026-03-05', curated_at: 'not-a-date' });
    expect(qualifies(note, '2026-06-01')).toBe(true);
  });
});

describe('collapsibleEntries', () => {
  it('is every dated entry except the newest RETAIN_RECENT', () => {
    const entries = collapsibleEntries(noteWith(12));
    expect(entries).toHaveLength(12 - RETAIN_RECENT);
    expect(entries[0]).toContain('Entry number 1.');
    expect(entries[entries.length - 1]).toContain(`Entry number ${String(12 - RETAIN_RECENT)}.`);
  });
});

describe('curate', () => {
  it('replaces the collapsed span with one dated-range entry and keeps the recent tail', () => {
    const out = curate(noteWith(12), RESULT, { date: '2026-03-01' });
    const timeline = out.body.split('## Timeline\n')[1].split('\n## ')[0].trim().split('\n');

    expect(timeline).toHaveLength(1 + RETAIN_RECENT);
    expect(timeline[0]).toBe(
      `- **2026-01-01 – 2026-01-07**: ${RESULT.collapsed} _(7 entries collapsed)_`,
    );
    expect(timeline[1]).toContain('Entry number 8.');
    expect(timeline[timeline.length - 1]).toContain('Entry number 12.');
  });

  it('promotes facts into Key facts without disturbing what is there', () => {
    const out = curate(noteWith(12), RESULT, { date: '2026-03-01' });
    const facts = out.body.split('## Key facts\n')[1].split('\n## ')[0].trim().split('\n');
    expect(facts).toEqual([
      '- Widgets are load-bearing.',
      '- The flange is revised roughly monthly.',
    ]);
  });

  it('never writes the human sections', () => {
    const out = curate(noteWith(12), RESULT, { date: '2026-03-01' });
    expect(out.body).toContain('- Ask Greg about the flange.');
    expect(out.body).toContain('Handle with care.');
  });

  it('stamps curated_at and leaves updated alone', () => {
    const out = curate(noteWith(12), RESULT, { date: '2026-03-01' });
    expect(out.frontmatter.curated_at).toBe('2026-03-01');
    // Curation is not a source event. `updated` means "latest source this note
    // has seen"; bumping it here would make a compressed note look freshly
    // sourced, and would also defeat the freshness guard in `qualifies`.
    expect(out.frontmatter.updated).toBe('2026-02-01');
  });

  it('takes the date range from the entries, not from the model', () => {
    // A model that tries to supply its own span cannot displace the computed
    // one: its text lands in the prose position, where it is merely wrong
    // rather than authoritative.
    const evil = { collapsed: '**1999-01-01 – 1999-12-31**: nope', promotedFacts: [] };
    const out = curate(noteWith(12), evil, { date: '2026-03-01' });
    expect(out.body).toContain(
      '- **2026-01-01 – 2026-01-07**: **1999-01-01 – 1999-12-31**: nope _(7 entries collapsed)_',
    );
    expect(out.body).not.toContain('- **1999-01-01');
  });

  it('flattens model prose that contains headings or newlines', () => {
    const messy = { collapsed: '## Heading\nline one\n\nline two', promotedFacts: [] };
    const out = curate(noteWith(12), messy, { date: '2026-03-01' });
    expect(out.body).toContain(
      '- **2026-01-01 – 2026-01-07**: Heading line one line two _(7 entries collapsed)_',
    );
    // A heading inside a bullet would restructure the note, which is exactly
    // what the structured path exists to prevent.
    expect(out.body).not.toContain('\n## Heading');
  });

  it('is byte-identical across repeated calls and does not mutate its input', () => {
    const note = noteWith(12);
    const before = serializeNote(note);
    const a = serializeNote(curate(note, RESULT, { date: '2026-03-01' }));
    const b = serializeNote(curate(note, RESULT, { date: '2026-03-01' }));
    expect(a).toBe(b);
    expect(serializeNote(note)).toBe(before);
  });

  it('stamps curated_at and changes nothing else when there is nothing to collapse', () => {
    const note = noteWith(RETAIN_RECENT);
    const out = curate(note, RESULT, { date: '2026-03-01' });
    expect(out.frontmatter.curated_at).toBe('2026-03-01');
    expect(out.body).toBe(note.body);
  });

  it('preserves hand-written undated Timeline lines', () => {
    const note = noteWith(12);
    note.body = note.body.replace(
      '- **2026-01-01**: Entry number 1.',
      '- **2026-01-01**: Entry number 1.\n- a hand-written line with no date',
    );
    const out = curate(note, RESULT, { date: '2026-03-01' });
    expect(out.body).toContain('- a hand-written line with no date');
  });
});

describe('Decisions curation (Plan 9)', () => {
  describe('qualifies', () => {
    it('is true for a note over the Decisions threshold with a short Timeline', () => {
      // The measured shape of PI-404-dashboard-builder-chrome.md: 38 decisions
      // against 7 timeline entries, the largest note in the vault, which the
      // Timeline-only gate could never reach.
      expect(qualifies(decisionNote(MIN_DECISION_ENTRIES, 2), '2026-05-01')).toBe(true);
    });

    it('is false below both thresholds', () => {
      expect(qualifies(decisionNote(MIN_DECISION_ENTRIES - 1, 2), '2026-05-01')).toBe(false);
    });

    it('still honours the cooldown when only Decisions qualify', () => {
      const note = decisionNote(MIN_DECISION_ENTRIES, 2, { curated_at: '2026-04-28' });
      expect(qualifies(note, '2026-05-01')).toBe(false);
    });

    it('is false for a note with neither section', () => {
      const freeform: ParsedNote = {
        frontmatter: {
          type: 'Note',
          aliases: [],
          keywords: [],
          created: '2026-01-01',
          updated: '2026-02-01',
          sources: [],
        },
        body: '# Freeform\n\n## Summary\nProse only.\n',
      };
      expect(qualifies(freeform, '2026-05-01')).toBe(false);
    });
  });

  describe('collapsibleDecisions', () => {
    it('is every dated decision except the newest RETAIN_RECENT_DECISIONS', () => {
      const got = collapsibleDecisions(decisionNote(12));
      expect(got).toHaveLength(12 - RETAIN_RECENT_DECISIONS);
      expect(got[0]).toContain('Decision number 1.');
      expect(got[got.length - 1]).toContain(`Decision number ${String(12 - RETAIN_RECENT_DECISIONS)}.`);
    });
  });

  describe('curate', () => {
    it('replaces the collapsed decisions with one dated-range bullet and keeps the tail', () => {
      const out = curate(decisionNote(12), RESULT, { date: '2026-05-01' });
      const decisions = sectionOf(out.body, 'Decisions');
      expect(decisions).toHaveLength(1 + RETAIN_RECENT_DECISIONS);
      expect(decisions[0]).toContain('**2026-03-01 – 2026-03-07**');
      expect(decisions[0]).toContain('Settled the flange material');
      expect(decisions[0]).toContain('_(7 decisions collapsed)_');
      expect(decisions[decisions.length - 1]).toContain('Decision number 12.');
    });

    it('takes the decisions date range from the bullets, not from the model', () => {
      // A model supplying its own span cannot displace the computed one: its
      // text lands in the prose position, where it is merely wrong rather than
      // authoritative. Same guarantee the Timeline fold already makes.
      const out = curate(
        decisionNote(12),
        { ...RESULT, collapsedDecisions: '**1999-01-01 – 1999-12-31**: nope' },
        { date: '2026-05-01' },
      );
      const first = sectionOf(out.body, 'Decisions')[0];
      expect(first).toBe(
        '- **2026-03-01 – 2026-03-07**: **1999-01-01 – 1999-12-31**: nope _(7 decisions collapsed)_',
      );
      expect(out.body).not.toContain('- **1999-01-01');
    });

    it('leaves Decisions alone when the section is under the retain floor', () => {
      const note = decisionNote(RETAIN_RECENT_DECISIONS, 2);
      const before = sectionOf(note.body, 'Decisions');
      const out = curate(note, RESULT, { date: '2026-05-01' });
      expect(sectionOf(out.body, 'Decisions')).toEqual(before);
    });

    it('collapses both sections in one pass when both are long', () => {
      const note = decisionNote(12, MIN_TIMELINE_ENTRIES + 2);
      const out = curate(note, RESULT, { date: '2026-05-01' });
      expect(sectionOf(out.body, 'Timeline')[0]).toContain('entries collapsed');
      expect(sectionOf(out.body, 'Decisions')[0]).toContain('decisions collapsed');
    });

    it('preserves hand-written undated Decisions lines', () => {
      const note = decisionNote(12);
      note.body = note.body.replace(
        '## Key facts',
        '- a hand-written note about the flange\n\n## Key facts',
      );
      const out = curate(note, RESULT, { date: '2026-05-01' });
      expect(sectionOf(out.body, 'Decisions')).toContain('- a hand-written note about the flange');
    });

    it('is byte-identical across repeated calls', () => {
      const note = decisionNote(12);
      const once = curate(note, RESULT, { date: '2026-05-01' });
      const twice = curate(note, RESULT, { date: '2026-05-01' });
      expect(serializeNote(twice)).toBe(serializeNote(once));
    });

    it('never rewrites Key facts bullets that were already there', () => {
      // Plan 9 §3: Key facts is deliberately not collapsed, only appended to.
      const out = curate(decisionNote(12), RESULT, { date: '2026-05-01' });
      expect(sectionOf(out.body, 'Key facts')).toContain('- Widgets are load-bearing.');
    });
  });
});
