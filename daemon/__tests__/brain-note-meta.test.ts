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

  it('reports a curation date when one exists', () => {
    const meta = toNoteMeta('Topics/a.md', note({ curated_at: '2026-08-25' }));
    expect(meta.curatedAt).toBe('2026-08-25');
  });
});
