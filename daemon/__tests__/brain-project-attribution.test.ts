import { describe, it, expect } from 'vitest';
import { projectLinkFor } from '../services/brain/project';
import type { ItemMetadata } from '../services/brain/sources/types';

describe('projectLinkFor', () => {
  const titles = [
    { title: 'OmniFex', aliases: ['omnifex', 'GreyChrist'] },
    { title: 'WIN', aliases: [] },
    { title: 'WombBeats-iOS', aliases: ['wombeats-ios', 'WombBeats'] },
    { title: 'rowboat', aliases: [] },
  ];

  function session(projectPath: string | null): ItemMetadata {
    return { kind: 'session', projectPath } as unknown as ItemMetadata;
  }

  it('derives a project from the cwd a session ran in', () => {
    expect(projectLinkFor(session('/Users/greg/Repos/personal/WIN'), titles))
      .toBe('[[Projects/WIN]]');
  });

  it('matches an existing project note whose spelling differs from the directory', () => {
    expect(projectLinkFor(session('/Users/greg/Repos/personal/omnifex'), titles))
      .toBe('[[Projects/OmniFex]]');
  });

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

  it('falls back to the directory name when no project note exists yet', () => {
    expect(projectLinkFor(session('/Users/greg/Repos/personal/brand-new'), titles))
      .toBe('[[Projects/brand-new]]');
  });

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

  it('is deterministic', () => {
    const a = projectLinkFor(session('/Users/greg/Repos/personal/omnifex'), titles);
    const b = projectLinkFor(session('/Users/greg/Repos/personal/omnifex'), [...titles].reverse());
    expect(a).toBe(b);
  });
});
