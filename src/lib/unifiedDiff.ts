export type DiffLineKind = 'add' | 'del' | 'ctx';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
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
  preamble: string[];
  files: DiffFile[];
  truncated: number;
}

const HUNK = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_HEADER = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/;

/** Drops split's trailing empty element: an empty line is a legal context line, and it inflated every count. */
function toLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function cleanPath(raw: string): string | null {
  const path = raw.replace(/\t.*$/, '').trim();
  if (path === '/dev/null') return null;
  return path.replace(/^"|"$/g, '').replace(/^[ab]\//, '');
}

/** Needs a hunk header AND a file marker: a false positive mangles ordinary output (npm/pip +/- lines, --stat). */
export function looksLikeUnifiedDiff(text: string): boolean {
  if (!text) return false;
  let sawFileMarker = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ') || line.startsWith('+++ ')) sawFileMarker = true;
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

/** `maxLines` caps kept body lines (the transcript is unvirtualised); counts are tallied before the cap. */
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

  // Returns the file rather than assigning it, so TS narrowing sees the assignment.
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
      if (!file) preamble.push(line);
      continue;
    }

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
