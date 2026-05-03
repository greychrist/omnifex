import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { findClaudeBinary } from '../services/util/find-claude-binary';

beforeEach(() => {
  vi.clearAllMocks();
});

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

  it('uses defaultWhich when no `which` dep is provided (success path)', () => {
    (execSync as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce('/usr/local/bin/claude\n');
    const result = findClaudeBinary({
      exists: (p) => p === '/usr/local/bin/claude',
      fallbacks: [],
    });
    expect(result).toBe('/usr/local/bin/claude');
  });

  it('takes only the first line of `which` output when multiple are returned', () => {
    (execSync as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce('/first/claude\n/second/claude\n');
    const result = findClaudeBinary({
      exists: (p) => p === '/first/claude',
      fallbacks: [],
    });
    expect(result).toBe('/first/claude');
  });

  it('returns null from defaultWhich when execSync throws', () => {
    (execSync as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('which not found');
    });
    const result = findClaudeBinary({
      exists: () => false,
      fallbacks: [],
    });
    expect(result).toBeNull();
  });

  it('returns null from defaultWhich when output is empty/whitespace', () => {
    (execSync as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce('   \n');
    const result = findClaudeBinary({
      exists: (p) => p === '/opt/homebrew/bin/claude',
      fallbacks: ['/opt/homebrew/bin/claude'],
    });
    // which returned null, fallbacks kicked in
    expect(result).toBe('/opt/homebrew/bin/claude');
  });
});
