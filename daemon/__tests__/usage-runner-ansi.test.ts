import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../services/usage-runner/ansi';

describe('stripAnsi', () => {
  // stripAnsi replays the stream into a character grid and serializes it, so
  // these expectations are "what a terminal would show", not "what a linear
  // substitution would emit". Runs of spaces still collapse to one on the way
  // out, which is why column padding does not show up below.
  it('strips SGR color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });
  it('converts cursor-forward (C) to a single space', () => {
    expect(stripAnsi('Welcome\x1b[5Cback')).toBe('Welcome back');
  });
  it('moves cursor-down (B) to the next row WITHOUT resetting the column', () => {
    // Column preservation is the real terminal behaviour and the whole reason
    // the grid exists: Claude's diffing renderer emits `\r ESC[3C ESC[1B` to
    // indent a row, then paints single cells at absolute columns. Treating B
    // as a plain newline put those cells at column 0 and lost the ones the
    // renderer stepped over — "general-purpose" arrived as "g neral-purpose".
    expect(stripAnsi('row1\x1b[1Brow2')).toBe('row1\n row2');
  });
  it('keeps a cell an earlier frame painted when a later frame steps over it', () => {
    // Frame 1 paints "general-purpose"; frame 2 repaints only the cells that
    // changed, jumping over the unchanged "e" with an absolute column move.
    const frame1 = 'general-purpose';
    const frame2 = '\r' + 'g' + '\x1b[3G' + 'neral-purpose';
    expect(stripAnsi(frame1 + frame2)).toBe('general-purpose');
  });
  it('converts cursor-next-line (E) to a newline', () => {
    expect(stripAnsi('row1\x1b[1Erow2')).toBe('row1\nrow2');
  });
  it('applies erase-line rather than ignoring it', () => {
    // `ESC[2K` clears the row, so the 'a' written before it is gone; the
    // cursor does not move, so 'b' lands back at column 1. The old stripper
    // dropped erases entirely and reported stale characters as current.
    expect(stripAnsi('a\x1b[2A\x1b[2Kb')).toBe(' b');
  });
  it('clears the screen on erase-display and on the alt-screen switch', () => {
    // Erase does not move the cursor, so what follows keeps its column —
    // Claude always sends an explicit `ESC[H` next, which is why the real
    // capture starts cleanly at the top-left.
    expect(stripAnsi('stale\x1b[2Jfresh')).toBe(' fresh');
    expect(stripAnsi('stale\x1b[2J\x1b[Hfresh')).toBe('fresh');
    expect(stripAnsi('shell scrollback\x1b[?1049h\x1b[Hdialog')).toBe('dialog');
  });
  it('restores a saved cursor position', () => {
    expect(stripAnsi('\x1b7abc\x1b8x')).toBe('xbc');
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
