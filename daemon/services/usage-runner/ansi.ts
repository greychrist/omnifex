// The CLI's diffing renderer steps over unchanged cells with cursor escapes, and `ESC[nB` moves down without resetting
// the column, so only replaying into a grid recovers the text. Unhandled sequences move nothing and write nothing.

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

  /** Runs of spaces collapse to one: the parser's regexes expect single spaces, not padded columns. */
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
            // Alternate-screen switch starts a fresh screen, which drops the shell's scrollback.
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
