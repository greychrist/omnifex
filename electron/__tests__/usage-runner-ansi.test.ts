import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../services/usage-runner/ansi';

describe('stripAnsi', () => {
  it('removes CSI color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });
  it('removes cursor movement and erase codes', () => {
    expect(stripAnsi('a\x1b[2Kb\x1b[1;1Hc')).toBe('abc');
  });
  it('removes OSC sequences (BEL terminated)', () => {
    expect(stripAnsi('\x1b]0;title\x07hi')).toBe('hi');
  });
  it('removes OSC sequences (ST terminated)', () => {
    expect(stripAnsi('\x1b]0;title\x1b\\hi')).toBe('hi');
  });
  it('preserves newlines and unicode', () => {
    expect(stripAnsi('\x1b[1mline1\x1b[0m\nline2 — ✓')).toBe('line1\nline2 — ✓');
  });
  it('handles empty input', () => {
    expect(stripAnsi('')).toBe('');
  });
});
