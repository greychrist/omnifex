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

  it('ANDs multiple terms', () => {
    expect(toFtsQuery('permission decider')).toBe('"permission" AND "decider"');
  });

  it('drops FTS5 operator keywords so they are not searched literally', () => {
    expect(toFtsQuery('foo OR bar')).toBe('"foo" AND "bar"');
    expect(toFtsQuery('foo NOT bar')).toBe('"foo" AND "bar"');
    expect(toFtsQuery('foo NEAR bar')).toBe('"foo" AND "bar"');
  });

  it('treats lowercase operator words as ordinary terms', () => {
    expect(toFtsQuery('this or that')).toBe('"this" AND "or" AND "that"');
  });

  it('neutralises embedded double quotes', () => {
    expect(toFtsQuery('say "hi"')).toBe('"say" AND "hi"');
  });

  it('strips wildcards and punctuation rather than passing them through', () => {
    expect(toFtsQuery('perm* (stdio)')).toBe('"perm" AND "stdio"');
  });

  it('preserves unicode letters and digits', () => {
    expect(toFtsQuery('café v2')).toBe('"café" AND "v2"');
  });

  it('returns null when the input is only operator keywords', () => {
    expect(toFtsQuery('AND OR NOT')).toBeNull();
  });
});
