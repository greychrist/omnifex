// Compact ANSI stripper covering what claude's TUI emits: CSI sequences,
// OSC sequences (BEL- or ST-terminated), and standalone control bytes that
// would otherwise show up as garbage in parsed text.

const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// OSC: ESC ] ... (BEL | ESC \)
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Single-shift / private-use ESC sequences without parameters
const BARE_ESC = /\x1b[NOPQ\\\^_]/g;

export function stripAnsi(input: string): string {
  return input
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(BARE_ESC, '');
}
