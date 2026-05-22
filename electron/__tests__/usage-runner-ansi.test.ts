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
  it('drops cursor-up and erase CSI sequences', () => {
    expect(stripAnsi('a\x1b[2A\x1b[2Kb')).toBe('ab');
  });
  it('converts cursor-position (H) to a space so per-cell-positioned TUI renderings stay parseable', () => {
    // Real-world break observed 2026-05-22 (Claude Code 2.1.148): the
    // /usage TUI lays out each label as a positioned cell using CUP
    // (`\x1b[<row>;<col>H`) between words instead of literal spaces. The
    // prior stripper mapped H → empty, fusing labels into "Totalcost:" /
    // "Currentsession" / "Currentweek(allmodels)" and breaking every
    // section-header and field regex in the parser.
    expect(stripAnsi('Total\x1b[1;7Hcost:\x1b[1;25H$0.0000')).toBe('Total cost: $0.0000');
  });
  it('converts horizontal-position-absolute (G) to a space', () => {
    expect(stripAnsi('Current\x1b[10Gsession')).toBe('Current session');
  });
  it('converts horizontal-vertical-position (f, alt CUP) to a space', () => {
    expect(stripAnsi('a\x1b[1;5fb')).toBe('a b');
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
