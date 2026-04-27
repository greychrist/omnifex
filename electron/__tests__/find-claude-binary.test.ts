import { describe, it, expect } from 'vitest';
import { findClaudeBinary } from '../services/util/find-claude-binary';

describe('findClaudeBinary', () => {
  it('returns null when no candidate exists', () => {
    expect(findClaudeBinary({ which: () => null, exists: () => false, fallbacks: [] })).toBeNull();
  });
  it('returns the `which` result if it exists', () => {
    expect(findClaudeBinary({
      which: () => '/usr/local/bin/claude',
      exists: (p) => p === '/usr/local/bin/claude',
      fallbacks: [],
    })).toBe('/usr/local/bin/claude');
  });
  it('falls back to known locations', () => {
    const exists = (p: string) => p === '/opt/homebrew/bin/claude';
    expect(findClaudeBinary({
      which: () => null,
      exists,
      fallbacks: ['/opt/homebrew/bin/claude'],
    })).toBe('/opt/homebrew/bin/claude');
  });
  it('skips a `which` result that does not exist on disk', () => {
    expect(findClaudeBinary({
      which: () => '/missing/claude',
      exists: (p) => p === '/opt/homebrew/bin/claude',
      fallbacks: ['/opt/homebrew/bin/claude'],
    })).toBe('/opt/homebrew/bin/claude');
  });
});
