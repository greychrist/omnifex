import { describe, it, expect } from 'vitest';
import { merge, type Provenance } from '../services/brain/merge';
import type { ExtractedEntity } from '../services/brain/extract';
import type { ParsedNote } from '../services/brain/types';

const entity: ExtractedEntity = {
  type: 'Subsystem',
  name: 'Permission decider',
  aliases: ['decider'],
  keywords: ['permissions', 'stdio'],
  summary: 'The stdio bridge enforcing permission changes.',
  links: [{ target: 'Projects/omnifex', relation: 'lives in' }],
  timelineEntry: 'Reworked to handle every mode, not just bypass.',
  decisions: [{ date: '2026-05-31', text: 'Enforce in OmniFex, not the CLI.' }],
  keyFacts: ['Only bypass was handled before.'],
};

const prov: Provenance = { sourceKey: 'session:abc123', date: '2026-05-31' };

describe('merge', () => {
  it('creates a note with the spec section order', () => {
    const note = merge(null, entity, prov);
    const order = [
      '## Summary',
      '## Connected to',
      '## Timeline',
      '## Decisions',
      '## Key facts',
      '## Open items',
      '## Assistant notes',
    ];
    let last = -1;
    for (const heading of order) {
      const at = note.body.indexOf(heading);
      expect(at, `${heading} present`).toBeGreaterThan(-1);
      expect(at, `${heading} in order`).toBeGreaterThan(last);
      last = at;
    }
    expect(note.body.startsWith('# Permission decider')).toBe(true);
    expect(note.frontmatter.type).toBe('Subsystem');
    expect(note.frontmatter.sources).toEqual(['session:abc123']);
  });

  it('is idempotent: merging the same extraction twice is byte-identical', () => {
    const once = merge(null, entity, prov);
    const twice = merge(once, entity, prov);
    // The property the spec names as the one to test hardest. If this drifts,
    // every re-index rewrites the vault and git history becomes noise.
    expect(twice).toEqual(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('is idempotent even on a later date', () => {
    const once = merge(null, entity, prov);
    const twice = merge(once, entity, { ...prov, date: '2026-09-01' });
    // `updated` bumps only when content actually changed. Stamping it
    // unconditionally would make the idempotency property untestable and every
    // re-index a commit.
    expect(twice.frontmatter.updated).toBe(once.frontmatter.updated);
    expect(twice).toEqual(once);
  });

  it('never appends a Timeline entry whose source key is already recorded', () => {
    const once = merge(null, entity, prov);
    const twice = merge(once, { ...entity, timelineEntry: 'A different sentence.' }, prov);
    // Dedup is by SOURCE KEY, not by text: re-running extraction on one
    // session legitimately produces different wording, and matching on text
    // would append a near-duplicate line every time.
    expect(twice.body).not.toContain('A different sentence.');
    expect(twice.body).toContain('Reworked to handle every mode');
  });

  it('appends a Timeline entry from a genuinely new source', () => {
    const first = merge(null, entity, prov);
    const second = merge(
      first,
      { ...entity, timelineEntry: 'Later work.' },
      { sourceKey: 'session:def456', date: '2026-06-02' },
    );
    expect(second.body).toContain('Later work.');
    expect(second.frontmatter.sources).toEqual(['session:abc123', 'session:def456']);
    // Chronological, so the note reads as a history.
    expect(second.body.indexOf('2026-05-31')).toBeLessThan(second.body.indexOf('2026-06-02'));
  });

  it('unions aliases and keywords without duplicating or reordering', () => {
    const first = merge(null, entity, prov);
    const second = merge(
      first,
      { ...entity, aliases: ['decider', 'permission-prompt-tool'], keywords: ['stdio', 'acceptEdits'] },
      { sourceKey: 'session:def456', date: '2026-06-02' },
    );
    expect(second.frontmatter.aliases).toEqual(['decider', 'permission-prompt-tool']);
    expect(second.frontmatter.keywords).toEqual(['permissions', 'stdio', 'acceptEdits']);
  });

  it('preserves hand-written text in Open items and Assistant notes', () => {
    const first = merge(null, entity, prov);
    const edited: ParsedNote = {
      ...first,
      body: first.body.replace(
        '## Open items\n',
        '## Open items\n- check the decider on Windows\n',
      ),
    };
    const second = merge(edited, entity, { sourceKey: 'session:def456', date: '2026-06-02' });
    // The user edits notes in this app. An extraction that silently discarded
    // their text would make the tab's edit box a trap.
    expect(second.body).toContain('check the decider on Windows');
  });

  it('replaces the Summary rather than accumulating summaries', () => {
    const first = merge(null, entity, prov);
    const second = merge(
      first,
      { ...entity, summary: 'A newer, better summary.' },
      { sourceKey: 'session:def456', date: '2026-06-02' },
    );
    expect(second.body).toContain('A newer, better summary.');
    expect(second.body).not.toContain('The stdio bridge enforcing permission changes.');
  });

  it('dedupes decisions, key facts and links by text', () => {
    const first = merge(null, entity, prov);
    const second = merge(first, entity, { sourceKey: 'session:def456', date: '2026-06-02' });
    expect(second.body.match(/Enforce in OmniFex/g)).toHaveLength(1);
    expect(second.body.match(/Only bypass was handled before/g)).toHaveLength(1);
    expect(second.body.match(/lives in/g)).toHaveLength(1);
  });

  it('renders links as wikilinks with their relation', () => {
    const note = merge(null, entity, prov);
    expect(note.body).toContain('- [[Projects/omnifex]] — lives in');
  });

  it('stamps the project link when given one', () => {
    const note = merge(null, entity, { ...prov, projectLink: '[[Projects/omnifex]]' });
    expect(note.frontmatter.project).toBe('[[Projects/omnifex]]');
  });

  it('takes its date from the caller and never reads a clock', () => {
    // A pure function that reads Date.now() is not pure, and its idempotency
    // test becomes a race against midnight.
    const note = merge(null, entity, { sourceKey: 's:1', date: '2020-01-01' });
    expect(note.frontmatter.created).toBe('2020-01-01');
    expect(note.frontmatter.updated).toBe('2020-01-01');
  });

  it('never changes created on a later merge', () => {
    const first = merge(null, entity, prov);
    const second = merge(
      first,
      { ...entity, summary: 'changed' },
      { sourceKey: 'session:def456', date: '2027-01-01' },
    );
    expect(second.frontmatter.created).toBe('2026-05-31');
    expect(second.frontmatter.updated).toBe('2027-01-01');
  });

  it('handles an entity with nothing but a name and summary', () => {
    const bare: ExtractedEntity = {
      type: 'Topic', name: 'Something', aliases: [], keywords: [],
      summary: 'A thing.', links: [], decisions: [], keyFacts: [],
    };
    const note = merge(null, bare, prov);
    expect(note.body).toContain('## Timeline');
    // No timelineEntry means no bullet, but the section still exists so the
    // note's shape is the same for every note in the vault.
    expect(note.body).toContain('A thing.');
  });
});
