/**
 * Unified diff → structure, so a diff can be rendered as a diff.
 *
 * A `git diff` that arrives as Bash stdout used to render as one flat block
 * of success-green text: the colour said "this command exited 0", which is
 * the least interesting fact about it, and nothing said which lines changed.
 * The dedicated `DiffViewer` never saw it, because that only ever gets `Edit`
 * and `apply_patch` payloads, which come as old/new strings rather than as a
 * diff someone else already computed.
 *
 * Parsing is deliberately conservative. `looksLikeUnifiedDiff` decides whether
 * a Bash result stops being text and becomes a diff, and a false positive
 * mangles ordinary output — so a hunk header is required, not merely lines
 * that begin with `+` or `-` (npm and pip print plenty of those).
 */

export type DiffLineKind = 'add' | 'del' | 'ctx';

export interface DiffLine {
  kind: DiffLineKind;
  /** The line without its leading +/-/space marker. */
  text: string;
  /** Line number on the old side, or null for an added line. */
  oldNumber: number | null;
  /** Line number on the new side, or null for a removed line. */
  newNumber: number | null;
}

export interface DiffHunk {
  /** The `@@ … @@` line verbatim, including any trailing section context. */
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** The path to show: the new path, or the old one for a deletion. */
  path: string;
  /** The old path when it differs (a rename), else null. */
  oldPath: string | null;
  created: boolean;
  deleted: boolean;
  renamed: boolean;
  binary: boolean;
  /** Counts for the WHOLE file, even when rendering was truncated. */
  added: number;
  removed: number;
  hunks: DiffHunk[];
}

export interface ParsedDiff {
  /** Anything printed before the first file header. Never dropped. */
  preamble: string[];
  files: DiffFile[];
  /** Body lines beyond the budget — 0 when everything was kept. */
  truncated: number;
}

const HUNK = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_HEADER = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/;

/**
 * The text as diff lines. `split('\n')` on trailing-newline text yields a
 * final empty element that is not a line — and an empty line is a legal
 * context line here, so left in place it counted as one, inflating every
 * line number and every +/- tally after it.
 */
function toLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Strip git's `a/` / `b/` prefix from a `---` / `+++` path. */
function cleanPath(raw: string): string | null {
  const path = raw.replace(/\t.*$/, '').trim();
  if (path === '/dev/null') return null;
  return path.replace(/^"|"$/g, '').replace(/^[ab]\//, '');
}

/**
 * Whether this text should be rendered as a diff rather than as output.
 *
 * Requires a hunk header AND a file marker, which is what separates a real
 * diff from `git diff --stat`, a changelog, or an installer's +/- lines.
 */
export function looksLikeUnifiedDiff(text: string): boolean {
  if (!text) return false;
  let sawFileMarker = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ') || line.startsWith('+++ ')) sawFileMarker = true;
    // A binary file has no hunk to find, and `Binary files … differ` under a
    // git header is as unambiguous as a hunk is.
    else if (sawFileMarker && line.startsWith('Binary files ')) return true;
    else if (sawFileMarker && HUNK.test(line)) return true;
  }
  return false;
}

function emptyFile(path: string): DiffFile {
  return {
    path,
    oldPath: null,
    created: false,
    deleted: false,
    renamed: false,
    binary: false,
    added: 0,
    removed: 0,
    hunks: [],
  };
}

/**
 * Parse unified diff text. Null when it is not a diff at all.
 *
 * `maxLines` caps how many body lines are kept across the whole diff — the
 * transcript is unvirtualised, so a 20,000-line diff would otherwise mount
 * 20,000 rows. Counts are tallied before the cap, so the header still tells
 * the truth about a diff that was only partly rendered.
 */
export function parseUnifiedDiff(
  text: string,
  opts: { maxLines?: number } = {},
): ParsedDiff | null {
  if (!looksLikeUnifiedDiff(text)) return null;
  const budget = opts.maxLines ?? Number.POSITIVE_INFINITY;

  const preamble: string[] = [];
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNumber = 0;
  let newNumber = 0;
  let kept = 0;
  let truncated = 0;

  // Returns the file rather than assigning it, so the assignment is visible
  // to control-flow narrowing at each call site (a closure that assigned
  // `file` left TS believing it was still null further down the loop).
  const openFile = (f: DiffFile): DiffFile => {
    files.push(f);
    hunk = null;
    return f;
  };

  for (const raw of toLines(text)) {
    const line = raw.replace(/\r$/, '');

    const gitHeader = GIT_HEADER.exec(line);
    if (gitHeader) {
      file = openFile(emptyFile(gitHeader[2]));
      if (gitHeader[1] !== gitHeader[2]) file.oldPath = gitHeader[1];
      continue;
    }

    if (line.startsWith('new file mode')) {
      if (file) file.created = true;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      if (file) file.deleted = true;
      continue;
    }
    if (line.startsWith('rename from ')) {
      if (file) {
        file.renamed = true;
        file.oldPath = line.slice('rename from '.length);
      }
      continue;
    }
    if (line.startsWith('rename to ')) {
      if (file) {
        file.renamed = true;
        file.path = line.slice('rename to '.length);
      }
      continue;
    }
    if (line.startsWith('Binary files ')) {
      if (file) file.binary = true;
      continue;
    }

    if (line.startsWith('--- ')) {
      const path = cleanPath(line.slice(4));
      // A bare `diff -u` has no `diff --git` line to open the file with.
      if (!file || file.hunks.length > 0) file = openFile(emptyFile(path ?? '(unknown)'));
      if (path === null) file.created = true;
      else if (!file.oldPath && file.path === '(unknown)') file.path = path;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = cleanPath(line.slice(4));
      file ??= openFile(emptyFile(path ?? '(unknown)'));
      if (path === null) file.deleted = true;
      else if (file.path === '(unknown)') file.path = path;
      continue;
    }

    const hunkHeader = HUNK.exec(line);
    if (hunkHeader) {
      file ??= openFile(emptyFile('(unknown)'));
      oldNumber = Number(hunkHeader[1]);
      newNumber = Number(hunkHeader[3]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }

    if (!hunk) {
      // `index abc..def`, `similarity index`, mode changes — and, before any
      // file has been opened, whatever the command printed first.
      if (!file) preamble.push(line);
      continue;
    }

    // `\ No newline at end of file` annotates the line above; it is not one.
    if (line.startsWith('\\')) continue;

    const marker = line[0];
    if (marker !== '+' && marker !== '-' && marker !== ' ' && line !== '') continue;

    const kind: DiffLineKind = marker === '+' ? 'add' : marker === '-' ? 'del' : 'ctx';
    if (file) {
      if (kind === 'add') file.added += 1;
      if (kind === 'del') file.removed += 1;
    }

    const body = line === '' ? '' : line.slice(1);
    const entry: DiffLine = {
      kind,
      text: body,
      oldNumber: kind === 'add' ? null : oldNumber,
      newNumber: kind === 'del' ? null : newNumber,
    };
    if (kind !== 'add') oldNumber += 1;
    if (kind !== 'del') newNumber += 1;

    if (kept < budget) {
      hunk.lines.push(entry);
      kept += 1;
    } else {
      truncated += 1;
    }
  }

  if (files.length === 0) return null;
  return { preamble, files, truncated };
}
