// Compact ANSI stripper for claude's TUI output.
//
// The TUI emits cursor-position commands to lay out content in a
// multi-row, multi-column panel. A naive strip-everything approach fuses
// all rows + columns into one giant line, which the parser can't read.
// We classify CSI sequences:
//
//   `\x1b[<n>B` (cursor down)   → newline (one per occurrence)
//   `\x1b[<n>E` (cursor next ln) → newline
//   `\x1b[...m` (SGR / color)    → empty
//   `\x1b[<n>C` (cursor forward)        → single space (preserves word breaks)
//   `\x1b[<n>G` (HPA — horizontal abs)  → single space
//   `\x1b[<r>;<c>H` (CUP — cursor pos)  → single space
//   `\x1b[<r>;<c>f` (HVP — alt CUP)     → single space
//   any other CSI                       → empty
//
// The H/G/f mappings landed 2026-05-22 after Claude Code 2.1.146+ began
// laying out the `/usage` TUI as positioned per-word cells. Dropping
// those escapes to empty fused labels into `Totalcost:` /
// `Currentsession` / `Currentweek(allmodels)`, which broke every
// section-header and field regex in the parser.
//
// OSC sequences and bare ESC commands are pure noise — stripped to empty.
// After processing, we collapse runs of spaces within each line so column
// alignment slack doesn't bloat the output.

// ANSI control sequences are inherently regex over control characters;
// the lint warning here is correct in the abstract but inapplicable.
/* eslint-disable no-control-regex */
const CSI_FULL = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const BARE_ESC = /\x1b[NOPQ\\^_]/g;
/* eslint-enable no-control-regex */

export function stripAnsi(input: string): string {
  const noEscapes = input
    .replace(OSC, '')
    .replace(BARE_ESC, '')
    .replace(CSI_FULL, (seq) => {
      const cmd = seq[seq.length - 1];
      if (cmd === 'B' || cmd === 'E') return '\n';
      if (cmd === 'C' || cmd === 'G' || cmd === 'H' || cmd === 'f') return ' ';
      return '';
    });
  return noEscapes
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' '))
    .join('\n');
}
