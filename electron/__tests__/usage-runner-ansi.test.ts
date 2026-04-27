import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../services/usage-runner/ansi';

describe('stripAnsi', () => {
  // SGR (color) sequences become empty; cursor-forward becomes a space to
  // preserve word boundaries; cursor-down becomes a newline so multi-row
  // panel content stays on separate lines for the parser.
  it('strips SGR color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });
  it('converts cursor-forward (C) to a single space', () => {
    expect(stripAnsi('Welcome\x1b[5Cback')).toBe('Welcome back');
  });
  it('converts cursor-down (B) to a newline', () => {
    expect(stripAnsi('row1\x1b[1Brow2')).toBe('row1\nrow2');
  });
  it('converts cursor-next-line (E) to a newline', () => {
    expect(stripAnsi('row1\x1b[1Erow2')).toBe('row1\nrow2');
  });
  it('drops other CSI sequences (cursor up, erase, position)', () => {
    expect(stripAnsi('a\x1b[2A\x1b[2Kb\x1b[10;5Hc')).toBe('abc');
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
  it('collapses runs of spaces within a line', () => {
    expect(stripAnsi('a\x1b[3C\x1b[5Cb')).toBe('a b');
  });
  it('handles empty input', () => {
    expect(stripAnsi('')).toBe('');
  });
});
