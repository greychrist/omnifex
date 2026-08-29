import { describe, it, expect } from 'vitest';
import { toFtsQuery } from '../services/brain/fts-query';

describe('toFtsQuery', () => {
  it('returns null for empty or whitespace input', () => {
    expect(toFtsQuery('')).toBeNull();
    expect(toFtsQuery('   ')).toBeNull();
  });

  it('returns null when no token survives', () => {
    expect(toFtsQuery('***')).toBeNull();
    expect(toFtsQuery('!!! ???')).toBeNull();
  });

  it('keeps hyphenated identifiers as one token', () => {
    expect(toFtsQuery('node-pty')).toBe('"node-pty"');
  });

  it('keeps underscored identifiers as one token', () => {
    expect(toFtsQuery('can_use_tool')).toBe('"can_use_tool"');
  });

  it('ORs multiple terms so partial matches still rank', () => {
    expect(toFtsQuery('permission decider')).toBe('"permission" OR "decider"');
  });

  // Regression: every token was ANDed, so each extra word narrowed the result
  // set to notes containing all of them. Real sessions measured a 0% hit rate
  // at four terms while the vault plainly held the content -- "encompass ops"
  // returned nothing though "encompass" alone matched 13 notes.
  it('does not require every term to be present', () => {
    expect(toFtsQuery('encompass ops')).toBe('"encompass" OR "ops"');
    expect(toFtsQuery('encompass docker compose lima')).toBe(
      '"encompass" OR "docker" OR "compose" OR "lima"'
    );
  });

  it('drops FTS5 operator keywords so they are not searched literally', () => {
    expect(toFtsQuery('foo OR bar')).toBe('"foo" OR "bar"');
    expect(toFtsQuery('foo NOT bar')).toBe('"foo" OR "bar"');
    expect(toFtsQuery('foo NEAR bar')).toBe('"foo" OR "bar"');
  });

  it('treats lowercase operator words as ordinary terms', () => {
    expect(toFtsQuery('this or that')).toBe('"this" OR "or" OR "that"');
  });

  it('neutralises embedded double quotes', () => {
    expect(toFtsQuery('say "hi"')).toBe('"say" OR "hi"');
  });

  it('strips wildcards and punctuation rather than passing them through', () => {
    expect(toFtsQuery('perm* (stdio)')).toBe('"perm" OR "stdio"');
  });

  it('preserves unicode letters and digits', () => {
    expect(toFtsQuery('café v2')).toBe('"café" OR "v2"');
  });

  it('returns null when the input is only operator keywords', () => {
    expect(toFtsQuery('AND OR NOT')).toBeNull();
  });

  it('returns null for non-string input (undefined, null, number)', () => {
    expect(toFtsQuery(undefined as unknown as string)).toBeNull();
    expect(toFtsQuery(null as unknown as string)).toBeNull();
    expect(toFtsQuery(123 as unknown as string)).toBeNull();
  });

  it('caps a pathological query rather than building a giant MATCH expression', () => {
    const huge = 'alpha '.repeat(5000);
    const out = toFtsQuery(huge);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(4000);
  });

  it('still returns null for a query that is only whitespace, however long', () => {
    expect(toFtsQuery(' '.repeat(5000))).toBeNull();
  });
});
