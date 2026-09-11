import { describe, it, expect } from 'vitest';
import { brainInstructions, MAX_INSTRUCTIONS_CHARS } from '../services/brain/instructions';
import type { ProjectTypeCount } from '../services/brain/instructions';

/** The shape `ReadonlyVaultIndex.projectCounts()` returns, as the server passes it. */
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
    // The other project's notes are not this project's business.
    expect(text).not.toContain('WombBeats');
  });

  it('matches a parent directory when the session starts in a subdirectory', () => {
    // The defect this replaces: the SessionStart hook compared only the cwd's
    // own basename, so a session opened in `omnifex/electron` was told nothing
    // at all — the Brain silently did not exist for it.
    const text = brainInstructions('/Users/greg/Repos/personal/omnifex/electron/services', OMNIFEX);
    expect(text).toContain('209 notes');
  });

  it('folds case and separators the way project attribution already does', () => {
    // The checkout is `womb-beats-ios`; the note is `Projects/WombBeats-iOS.md`.
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
    // Silence here was the hook's behaviour and it is wrong: cross-cutting
    // notes routinely answer questions asked from an unattributed directory.
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
    // The whole reason this text exists. A variant that describes the vault
    // without saying when to reach for it reproduces the 8% invocation rate
    // that the SessionStart hook was written to fix.
    for (const cwd of ['/Users/greg/Repos/personal/omnifex', '/tmp/scratch', null]) {
      const text = brainInstructions(cwd, OMNIFEX);
      expect(text).toContain('diagnose a bug');
      expect(text).toContain('brain_search');
    }
  });

  it('stays small enough to sit in every session prompt', () => {
    // This is not a tool result paid for on use — it is in the system prompt of
    // every session that connects the server, whether or not the Brain is
    // touched. A directive that costs more than it saves is a net loss.
    for (const rows of [OMNIFEX, []]) {
      expect(brainInstructions('/Users/greg/Repos/personal/omnifex', rows).length).toBeLessThanOrEqual(
        MAX_INSTRUCTIONS_CHARS,
      );
    }
  });
});
