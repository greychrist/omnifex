import { describe, it, expect } from 'vitest';
import { parseBtw } from '../sideChat';

describe('parseBtw', () => {
  it('extracts the question', () => { expect(parseBtw('/btw  what is x?  ')).toBe('what is x?'); });
  it('bare /btw opens the panel', () => { expect(parseBtw('/btw')).toBe(''); });
  it('keeps newlines inside the question', () => { expect(parseBtw('/btw a\nb')).toBe('a\nb'); });
  it('ignores other commands and look-alikes', () => {
    expect(parseBtw('/btwx')).toBeNull();
    expect(parseBtw('hello /btw')).toBeNull();
    expect(parseBtw('/compact')).toBeNull();
  });
});
