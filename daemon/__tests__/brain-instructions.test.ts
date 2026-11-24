import { describe, it, expect } from 'vitest';
import { brainInstructions, MAX_INSTRUCTIONS_CHARS } from '../services/brain/instructions';
import type { ProjectTypeCount } from '../services/brain/instructions';

function counts(...rows: [string, string, number][]): ProjectTypeCount[] {
  return rows.map(([project, type, count]) => ({ project, type, count }));
}

const OMNIFEX = counts(
  ['[[Projects/OmniFex]]', 'Subsystem', 85],
  ['[[Projects/OmniFex]]', 'Topic', 124],
  ['[[Projects/WombBeats-iOS]]', 'Topic', 7],
  ['', 'Note', 3],
);

describe('brain MCP instructions', () => {
  it('names what the current project has, so the count is concrete', () => {
    const text = brainInstructions('/Users/greg/Repos/personal/omnifex', OMNIFEX);
    expect(text).toContain('209 notes');
    expect(text).toContain('85 Subsystems');
    expect(text).toContain('124 Topics');
    expect(text).not.toContain('WombBeats');
  });

  it('matches a parent directory when the session starts in a subdirectory', () => {
    const text = brainInstructions('/Users/greg/Repos/personal/omnifex/daemon/services', OMNIFEX);
    expect(text).toContain('209 notes');
  });

  it('folds case and separators the way project attribution already does', () => {
    const text = brainInstructions('/Users/greg/Repos/personal/womb-beats-ios', OMNIFEX);
    expect(text).toContain('7 notes');
    expect(text).toContain('7 Topics');
  });

  it('prefers the nearest ancestor when two ancestors are both projects', () => {
    const nested = counts(
      ['[[Projects/monorepo]]', 'Topic', 40],
      ['[[Projects/packages]]', 'Topic', 2],
    );
    const text = brainInstructions('/Users/greg/monorepo/packages/app', nested);
    expect(text).toContain('2 notes');
    expect(text).not.toContain('40 notes');
  });

  it('still invites a search when the cwd matches no project', () => {
    const text = brainInstructions('/tmp/scratch', OMNIFEX);
    expect(text).toContain('brain_search');
    expect(text).toContain('219');
    expect(text).not.toContain('209 notes');
  });

  it('describes capture but promises no knowledge when the vault is empty', () => {
    const text = brainInstructions('/Users/greg/Repos/personal/omnifex', []);
    expect(text).toContain('brain_remember');
    expect(text).not.toMatch(/\d+ notes/);
  });

  it('survives an unknown working directory', () => {
    expect(() => brainInstructions(null, OMNIFEX)).not.toThrow();
    expect(brainInstructions(null, OMNIFEX)).toContain('brain_search');
  });

  it('always states the trigger conditions, in every variant', () => {
    for (const cwd of ['/Users/greg/Repos/personal/omnifex', '/tmp/scratch', null]) {
      const text = brainInstructions(cwd, OMNIFEX);
      expect(text).toContain('diagnose a bug');
      expect(text).toContain('brain_search');
    }
  });

  it('stays small enough to sit in every session prompt', () => {
    for (const rows of [OMNIFEX, []]) {
      expect(brainInstructions('/Users/greg/Repos/personal/omnifex', rows).length).toBeLessThanOrEqual(
        MAX_INSTRUCTIONS_CHARS,
      );
    }
  });
});
