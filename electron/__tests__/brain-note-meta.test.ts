import { describe, it, expect } from 'vitest';
import { projectName, toNoteMeta } from '../services/brain/note-meta';
import type { NoteFrontmatter, ParsedNote } from '../services/brain/types';

function note(fm: Partial<NoteFrontmatter> = {}): ParsedNote {
  return {
    frontmatter: {
      type: 'Subsystem',
      aliases: [],
      keywords: [],
      created: '2026-08-01',
      updated: '2026-08-20',
      sources: [],
      ...fm,
    },
    body: '# x\n',
  };
}

describe('projectName', () => {
  /**
   * `project` is stored as a wikilink — `"[[Projects/WIN]]"` — because that is
   * what makes it navigable in Obsidian. A table column showing the raw link
   * would sort on the shared `[[Projects/` prefix and group on nothing.
   */
  it('reads the note name out of a wikilink target', () => {
    expect(projectName('[[Projects/WIN]]')).toBe('WIN');
  });

  it('keeps a bare name that was never a link', () => {
    expect(projectName('WIN')).toBe('WIN');
  });

  it('prefers the display half of a piped link', () => {
    expect(projectName('[[Projects/WIN|The WIN app]]')).toBe('The WIN app');
  });

  it('drops a .md suffix', () => {
    expect(projectName('[[Projects/WIN.md]]')).toBe('WIN');
  });

  // An unowned note is a real state — 7 of 338 in the live vault — and must be
  // distinguishable from a project literally named "".
  it('is null for an absent or empty project', () => {
    expect(projectName(undefined)).toBeNull();
    expect(projectName('   ')).toBeNull();
    expect(projectName('[[]]')).toBeNull();
  });
});

describe('toNoteMeta', () => {
  it('carries the columns the notes table sorts on', () => {
    expect(toNoteMeta('Subsystems/win-ai.md', note({ project: '[[Projects/WIN]]' }))).toEqual({
      relPath: 'Subsystems/win-ai.md',
      title: 'win-ai',
      type: 'Subsystem',
      project: 'WIN',
      created: '2026-08-01',
      updated: '2026-08-20',
      curatedAt: null,
    });
  });

  /**
   * Only 20 of 338 notes in the live vault carry `curated_at`. It is a second
   * line under Updated rather than a column of its own precisely because of
   * that ratio, and null is what the UI renders as an em dash.
   */
  it('reports a curation date when one exists', () => {
    const meta = toNoteMeta('Topics/a.md', note({ curated_at: '2026-08-25' }));
    expect(meta.curatedAt).toBe('2026-08-25');
  });
});
