import { describe, it, expect } from 'vitest';
import { projectLinkFor } from '../services/brain/project';
import type { ItemMetadata } from '../services/brain/sources/types';

/**
 * Which project a note belongs to.
 *
 * `merge()` has always honoured `provenance.projectLink` and the FTS index has
 * always carried a `project` column, but nothing ever computed the value — so
 * the field was empty on every note in every vault, and `brain_search`'s
 * documented `project` filter could only ever return zero hits.
 *
 * The value is derived, never asked of the model: every source kind already
 * knows the path its material came from, and a model-supplied project name
 * would be one more thing to get wrong.
 */
describe('projectLinkFor', () => {
  const titles = [
    { title: 'OmniFex', aliases: ['omnifex', 'GreyChrist'] },
    { title: 'WIN', aliases: [] },
    { title: 'WombBeats-iOS', aliases: ['wombeats-ios', 'WombBeats'] },
    { title: 'rowboat', aliases: [] },
  ];

  /**
   * Only the fields under test. The real metadata carries a dozen more that
   * attribution must not depend on — a full fixture would suggest otherwise.
   */
  function session(projectPath: string | null): ItemMetadata {
    return { kind: 'session', projectPath } as unknown as ItemMetadata;
  }

  it('derives a project from the cwd a session ran in', () => {
    expect(projectLinkFor(session('/Users/greg/Repos/personal/WIN'), titles))
      .toBe('[[Projects/WIN]]');
  });

  /**
   * The repo directory is `omnifex`; the note is `Projects/OmniFex.md`. Linking
   * to the directory spelling would produce a link that resolves to nothing and
   * a filter value that never matches the note it means.
   */
  it('matches an existing project note whose spelling differs from the directory', () => {
    expect(projectLinkFor(session('/Users/greg/Repos/personal/omnifex'), titles))
      .toBe('[[Projects/OmniFex]]');
  });

  /**
   * `wombeats-ios` folds to `wombeatsios` and the note title folds to
   * `wombbeatsios` — a letter apart, so no case/separator folding reaches it.
   * The note lists the directory name among its aliases, which is the same
   * escape hatch `resolve.ts` relies on.
   */
  it('matches a project by alias when the directory name is not its title', () => {
    expect(projectLinkFor(session('/Users/greg/Repos/personal/wombeats-ios'), titles))
      .toBe('[[Projects/WombBeats-iOS]]');
  });

  it('prefers a title match over another note that lists the name as an alias', () => {
    const projects = [
      { title: 'decoy', aliases: ['omnifex'] },
      { title: 'OmniFex', aliases: [] },
    ];
    expect(projectLinkFor(session('/Users/greg/Repos/personal/omnifex'), projects))
      .toBe('[[Projects/OmniFex]]');
  });

  /**
   * A project with no note yet is still a real project — the note is usually
   * written by the very run being attributed. Falling back to the directory
   * name keeps first-run attribution working instead of silently dropping it.
   */
  it('falls back to the directory name when no project note exists yet', () => {
    expect(projectLinkFor(session('/Users/greg/Repos/personal/brand-new'), titles))
      .toBe('[[Projects/brand-new]]');
  });

  /**
   * No cwd means no known path. The adapters already refuse to guess one; this
   * must not invent an attribution the sources cannot support.
   */
  it('returns undefined when the session has no cwd', () => {
    expect(projectLinkFor(session(null), titles)).toBeUndefined();
  });

  it('derives a project from an instruction file repoPath', () => {
    const artifact = {
      kind: 'artifact',
      repoPath: '/Users/greg/Repos/personal/omnifex',
    } as unknown as ItemMetadata;
    expect(projectLinkFor(artifact, titles)).toBe('[[Projects/OmniFex]]');
  });

  it('derives a project from a capture cwd', () => {
    const capture = { kind: 'capture', cwd: '/Users/greg/Repos/personal/WIN' } as unknown as ItemMetadata;
    expect(projectLinkFor(capture, titles)).toBe('[[Projects/WIN]]');
  });

  it('ignores a trailing slash on the path', () => {
    expect(projectLinkFor(session('/Users/greg/Repos/personal/WIN/'), titles))
      .toBe('[[Projects/WIN]]');
  });

  /** Pure: same inputs, same output, no I/O. Re-indexing must not drift. */
  it('is deterministic', () => {
    const a = projectLinkFor(session('/Users/greg/Repos/personal/omnifex'), titles);
    const b = projectLinkFor(session('/Users/greg/Repos/personal/omnifex'), [...titles].reverse());
    expect(a).toBe(b);
  });
});
