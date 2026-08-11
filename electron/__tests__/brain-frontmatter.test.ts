import { describe, it, expect } from 'vitest';
import { parseNote, serializeNote, NoteParseError } from '../services/brain/frontmatter';

const SAMPLE = `---
type: Subsystem
project: "[[Projects/omnifex]]"
aliases: [permission decider, permission-prompt-tool]
keywords: [permissions, stdio]
created: 2026-05-31
updated: 2026-08-08
sources: [session:abc123]
---
# Permission decider

## Summary
Enforces mid-session permission changes.
`;

describe('parseNote', () => {
  it('parses frontmatter fields', () => {
    const note = parseNote(SAMPLE);
    expect(note.frontmatter.type).toBe('Subsystem');
    expect(note.frontmatter.aliases).toEqual(['permission decider', 'permission-prompt-tool']);
    expect(note.frontmatter.keywords).toEqual(['permissions', 'stdio']);
    expect(note.frontmatter.sources).toEqual(['session:abc123']);
    expect(note.frontmatter.project).toBe('[[Projects/omnifex]]');
  });

  it('keeps the body verbatim, without the fence', () => {
    const note = parseNote(SAMPLE);
    expect(note.body.startsWith('# Permission decider')).toBe(true);
    expect(note.body).not.toContain('---');
  });

  it('defaults missing list fields to empty arrays', () => {
    const note = parseNote('---\ntype: Topic\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# T\n');
    expect(note.frontmatter.aliases).toEqual([]);
    expect(note.frontmatter.keywords).toEqual([]);
    expect(note.frontmatter.sources).toEqual([]);
  });

  it('does not bleed the next line into an empty field', () => {
    // The exact bug Rowboat's regex-based extractField had to be patched for.
    const note = parseNote('---\ntype: Topic\nproject:\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# T\n');
    expect(note.frontmatter.project).toBeUndefined();
  });

  it('throws NoteParseError when the fence is missing', () => {
    expect(() => parseNote('# Just a heading\n')).toThrow(NoteParseError);
  });

  it('throws NoteParseError on malformed YAML', () => {
    expect(() => parseNote('---\ntype: [unclosed\n---\n# T\n')).toThrow(NoteParseError);
  });

  it('throws NoteParseError on an unknown note type', () => {
    expect(() => parseNote('---\ntype: Alien\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# T\n'))
      .toThrow(NoteParseError);
  });
});

describe('serializeNote', () => {
  it('round-trips: parse then serialize then parse is stable', () => {
    const once = serializeNote(parseNote(SAMPLE));
    const twice = serializeNote(parseNote(once));
    expect(twice).toBe(once);
  });

  it('omits undefined optional fields entirely', () => {
    const out = serializeNote({
      frontmatter: {
        type: 'Topic', aliases: [], keywords: [], sources: [],
        created: '2026-01-01', updated: '2026-01-01',
      },
      body: '# T\n',
    });
    expect(out).not.toContain('project:');
    expect(out).not.toContain('curated_at:');
  });

  it('emits a parseable fence', () => {
    const out = serializeNote({
      frontmatter: {
        type: 'Project', aliases: ['a'], keywords: [], sources: [],
        created: '2026-01-01', updated: '2026-01-01',
      },
      body: '# P\n',
    });
    expect(parseNote(out).frontmatter.aliases).toEqual(['a']);
  });
});
