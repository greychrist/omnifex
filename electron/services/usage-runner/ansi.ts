// Screen replay for claude's TUI output.
//
// The `/usage` dialog is drawn by a DIFFING renderer. After the first full
// paint, each subsequent frame re-emits only the cells whose contents changed
// and steps over the unchanged ones with cursor-positioning escapes. A real
// terminal keeps the stepped-over cells; a linear "escape → space" stripper
// cannot, because the character was never in the byte stream a second time.
//
// Captured from 2.1.236, the Subagents row arrives as:
//
//   \r  ESC[3C  ESC[1B  g  ESC[6G  neral-purpose
//
// `ESC[1B` moves DOWN WITHOUT RESETTING THE COLUMN, and `ESC[6G` jumps over
// the cell holding `e`. Stripping each escape to a single space yields
// `g neral-purpose`; only replaying into a grid yields `general-purpose`.
// That is what this module does — it maintains a character grid, applies
// cursor motion and erase operations to it, and serializes the result.
//
// Every corruption the old stripper produced (`/ mnifex-rele se`,
// `mc -atlassian`, `these ind p nd t characteristi s`) came from this one
// cause. `electron/__tests__/usage-runner-render.test.ts` pins it against a
// real captured render.
//
// Only the subset of sequences Claude's TUI actually emits is implemented;
// anything else is skipped rather than guessed at. Unhandled sequences move
// no cursor and write no cells, which is the safe failure mode.

// ANSI control sequences are inherently regex over control characters;
// the lint warning here is correct in the abstract but inapplicable.
/* eslint-disable no-control-regex */
const CSI = /^\x1b\[([0-?]*)([ -/]*)([@-~])/;
const OSC_END = /\x07|\x1b\\/;
/* eslint-enable no-control-regex */

class Screen {
  private rows: string[][] = [];
  private row = 0;
  private col = 0;
  private savedRow = 0;
  private savedCol = 0;

  private lineAt(r: number): string[] {
    while (this.rows.length <= r) this.rows.push([]);
    return this.rows[r];
  }

  write(ch: string): void {
    const line = this.lineAt(this.row);
    // Pad with spaces rather than holes so a later join() sees real cells.
    while (line.length < this.col) line.push(' ');
    line[this.col] = ch;
    this.col += 1;
  }

  moveTo(row: number, col: number): void {
    this.row = Math.max(0, row);
    this.col = Math.max(0, col);
  }

  moveBy(rows: number, cols: number): void {
    this.moveTo(this.row + rows, this.col + cols);
  }

  get cursor(): { row: number; col: number } {
    return { row: this.row, col: this.col };
  }

  carriageReturn(): void {
    this.col = 0;
  }

  lineFeed(): void {
    this.row += 1;
    this.col = 0;
  }

  tab(): void {
    this.col += 8 - (this.col % 8);
  }

  saveCursor(): void {
    this.savedRow = this.row;
    this.savedCol = this.col;
  }

  restoreCursor(): void {
    this.row = this.savedRow;
    this.col = this.savedCol;
  }

  /** ED — 0: cursor→end of screen, 1: start→cursor, 2/3: everything. */
  eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.rows = [];
      return;
    }
    if (mode === 0) {
      this.eraseLine(0);
      this.rows.length = Math.min(this.rows.length, this.row + 1);
      return;
    }
    for (let r = 0; r < this.row && r < this.rows.length; r += 1) this.rows[r] = [];
    this.eraseLine(1);
  }

  /** EL — 0: cursor→end of line, 1: start→cursor, 2: whole line. */
  eraseLine(mode: number): void {
    const line = this.lineAt(this.row);
    if (mode === 0) {
      line.length = Math.min(line.length, this.col);
      return;
    }
    if (mode === 1) {
      for (let c = 0; c <= this.col && c < line.length; c += 1) line[c] = ' ';
      return;
    }
    line.length = 0;
  }

  /**
   * Serialize to text. Trailing whitespace goes per row, and runs of spaces
   * collapse to one so the parser's `<label> <value>` regexes see the same
   * single-space shape they always have — the grid pads to real screen
   * columns, which would otherwise leave 40-space gutters between columns.
   */
  toString(): string {
    return this.rows
      .map((line) => line.join('').replace(/\s+$/, '').replace(/ {2,}/g, ' '))
      .join('\n');
  }
}

export function stripAnsi(input: string): string {
  const screen = new Screen();
  let i = 0;
  while (i < input.length) {
    const ch = input[i];

    if (ch === '\x1b') {
      const next = input[i + 1];

      if (next === '[') {
        const m = CSI.exec(input.slice(i));
        if (!m) {
          i += 1;
          continue;
        }
        const [full, rawParams, , final] = m;
        const isPrivate = rawParams.startsWith('?');
        const params = (isPrivate ? rawParams.slice(1) : rawParams)
          .split(';')
          .map((p) => (p === '' ? undefined : Number.parseInt(p, 10)));
        const n = params[0] ?? 1;

        switch (final) {
          case 'A': screen.moveBy(-n, 0); break;
          case 'B': screen.moveBy(n, 0); break;   // down — column PRESERVED
          case 'C': screen.moveBy(0, n); break;
          case 'D': screen.moveBy(0, -n); break;
          case 'E': screen.moveTo(screen.cursor.row + n, 0); break;
          case 'F': screen.moveTo(screen.cursor.row - n, 0); break;
          case 'G': screen.moveTo(screen.cursor.row, n - 1); break;
          case 'H':
          case 'f': screen.moveTo((params[0] ?? 1) - 1, (params[1] ?? 1) - 1); break;
          case 'J': screen.eraseDisplay(params[0] ?? 0); break;
          case 'K': screen.eraseLine(params[0] ?? 0); break;
          case 'h':
          case 'l':
            // Alternate-screen switch starts a fresh screen, exactly as it
            // does in a real terminal. Claude enters it at startup, so this
            // is what drops the shell's scrollback from the capture.
            if (isPrivate && params.includes(1049)) screen.eraseDisplay(2);
            break;
          default: break; // SGR (m), scroll (S/T), device queries, … — no cell effect
        }
        i += full.length;
        continue;
      }

      if (next === ']') {
        const end = OSC_END.exec(input.slice(i));
        i += end ? end.index + end[0].length : 1;
        continue;
      }
      if (next === '7') { screen.saveCursor(); i += 2; continue; }
      if (next === '8') { screen.restoreCursor(); i += 2; continue; }
      // Charset designators (ESC ( B, ESC ) 0, …) carry one more byte.
      if (next === '(' || next === ')' || next === '*' || next === '+') { i += 3; continue; }
      i += 2;
      continue;
    }

    if (ch === '\r') { screen.carriageReturn(); i += 1; continue; }
    if (ch === '\n') { screen.lineFeed(); i += 1; continue; }
    if (ch === '\b') { screen.moveBy(0, -1); i += 1; continue; }
    if (ch === '\t') { screen.tab(); i += 1; continue; }
    // BEL and the shift-in/shift-out charset toggles paint nothing.
    if (ch === '\x07' || ch === '\x0e' || ch === '\x0f') { i += 1; continue; }

    screen.write(ch);
    i += 1;
  }
  return screen.toString();
}
