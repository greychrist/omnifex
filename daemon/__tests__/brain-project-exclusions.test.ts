import { describe, expect, it } from 'vitest';
import {
  isExcludedProject,
  isTempProject,
  parseDecisions,
} from '../services/brain/exclusions';

/**
 * Which projects the Brain may touch.
 *
 * A pure decision so the rule can be pinned without a database, a vault or a
 * discovery pass — and so the one predicate really is the one used at every
 * enforcement point.
 */

describe('isTempProject', () => {
  it.each([
    '/private/tmp/brain-probe',
    '/tmp/scratch',
    '/private/var/folders/xy/T/thing',
    '/var/folders/xy/T/omnifex-summary-scratch',
  ])('treats %s as scratch', (path) => {
    expect(isTempProject(path)).toBe(true);
  });

  it.each([
    '/Users/greg/Repos/personal/omnifex',
    '/Users/greg/private/notes',
    '/Users/greg/tmp-ideas',
  ])('leaves %s alone', (path) => {
    // The rule is a path PREFIX. A repo that merely has "tmp" or "private" in
    // its name is someone's actual work.
    expect(isTempProject(path)).toBe(false);
  });
});

describe('isExcludedProject', () => {
  it('excludes a scratch path when no decision has been recorded', () => {
    expect(isExcludedProject('/private/tmp/brain-probe', {})).toBe(true);
  });

  it('includes an ordinary path when no decision has been recorded', () => {
    expect(isExcludedProject('/Users/greg/Repos/personal/omnifex', {})).toBe(false);
  });

  /** The default has to be overridable, or it is not a default. */
  it('lets an explicit include beat the scratch rule', () => {
    expect(isExcludedProject('/private/tmp/brain-probe', { '/private/tmp/brain-probe': false }))
      .toBe(false);
  });

  it('lets an explicit exclude cover an ordinary path', () => {
    expect(isExcludedProject('/Users/greg/Repos/work', { '/Users/greg/Repos/work': true }))
      .toBe(true);
  });
});

describe('parseDecisions', () => {
  it('reads a stored map', () => {
    expect(parseDecisions('{"/a":true,"/b":false}')).toEqual({ '/a': true, '/b': false });
  });

  it('reads an absent setting as no decisions, so the defaults apply', () => {
    expect(parseDecisions(null)).toEqual({});
  });

  /**
   * Fails OPEN on a mangled value. Failing closed would index nothing and look
   * exactly like the Brain being broken.
   */
  it.each(['not json', '[]', '"a string"', '{"/a":"yes"}'])(
    'reads %s as no decisions rather than throwing',
    (raw) => {
      expect(parseDecisions(raw)).toEqual({});
    },
  );

  it('keeps the valid entries when only one is malformed', () => {
    expect(parseDecisions('{"/a":true,"/b":"nope"}')).toEqual({ '/a': true });
  });
});
