import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, dirname, basename, relative, resolve, sep } from 'node:path';
import { parseNote, serializeNote } from './frontmatter';
import { NOTE_FOLDERS, type NoteType, type ParsedNote } from './types';

export class VaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultPathError';
  }
}

const EXCLUDED_DIRS = new Set(['.git', '.omnifex']);

const MAX_NAME_BYTES = 255;

const DEFAULT_NOTE_DEFS = [
  {
    type: 'Project',
    folder: 'Projects',
    template: '# {Name}\n\n## Summary\n\n## Subsystems\n\n## Topics\n\n## Timeline\n\n## Decisions\n\n## Key facts\n\n## Open items\n\n## Assistant notes\n',
    extractionGuide: 'Look for: repo purpose, stack, conventions, status.',
  },
  {
    type: 'Subsystem',
    folder: 'Subsystems',
    template: '# {Name}\n\n## Summary\n\n## Connected to\n\n## Timeline\n\n## Decisions\n\n## Key facts\n\n## Open items\n\n## Assistant notes\n',
    extractionGuide: 'Look for: component name, responsibility, owning project, constraints.',
  },
  {
    type: 'Topic',
    folder: 'Topics',
    template: '# {Name}\n\n## Summary\n\n## Related\n\n## Timeline\n\n## Decisions\n\n## Key facts\n\n## Open items\n\n## Assistant notes\n',
    extractionGuide: 'Look for: cross-cutting concern, keywords, related projects.',
  },
  { type: 'Session', folder: 'Sessions', template: '', extractionGuide: 'Session digest record.' },
  { type: 'Note', folder: 'Notes', template: '', extractionGuide: 'Explicit capture or ingested memory.' },
];

const GITIGNORE = '# Derived search index — rebuildable from the Markdown.\n.omnifex/\n';

export interface Vault {
  readonly root: string;
  ensureLayout(): void;
  notePath(type: NoteType, name: string): string;
  readNote(relPath: string): ParsedNote;
  writeNote(relPath: string, note: ParsedNote): void;
  /** Absent is not an error. */
  deleteNote(relPath: string): void;
  listNotes(): string[];
  noteTitle(relPath: string): string;
}

export function createVault(root: string): Vault {
  const absoluteRoot = resolve(root);

  // Symlink checks compare against the real root, so a vault reached via a symlink still works.
  let cachedRealRoot: string | null = null;
  function realRoot(): string {
    if (cachedRealRoot === null) {
      cachedRealRoot = existsSync(absoluteRoot) ? realpathSync(absoluteRoot) : absoluteRoot;
    }
    return cachedRealRoot;
  }

  /** Hard links share an inode, so realpath containment cannot see them. Directories are exempt: nlink > 1 is normal there. */
  function assertSingleName(abs: string, relPath: string): void {
    const stat = lstatSync(abs, { throwIfNoEntry: false });
    if (stat && stat.isFile() && stat.nlink > 1) {
      throw new VaultPathError(`note file is hard-linked: ${relPath}`);
    }
  }

  /** A lexical prefix check is not enough: a symlink inside the vault can point out, so realpath the deepest existing ancestor. */
  function safeJoin(relPath: string): string {
    const abs = resolve(absoluteRoot, relPath);
    if (abs !== absoluteRoot && !abs.startsWith(absoluteRoot + sep)) {
      throw new VaultPathError(`path escapes the vault root: ${relPath}`);
    }

    let probe = abs;
    const tail: string[] = [];
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) throw new VaultPathError(`path escapes the vault root: ${relPath}`);
      tail.unshift(basename(probe));
      probe = parent;
    }
    const resolved = tail.length > 0 ? join(realpathSync(probe), ...tail) : realpathSync(probe);
    const root = realRoot();
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new VaultPathError(`path escapes the vault root via a symlink: ${relPath}`);
    }
    assertSingleName(abs, relPath);
    return abs;
  }

  return {
    root: absoluteRoot,

    ensureLayout(): void {
      mkdirSync(absoluteRoot, { recursive: true });
      for (const folder of Object.values(NOTE_FOLDERS)) {
        mkdirSync(join(absoluteRoot, folder), { recursive: true });
      }
      mkdirSync(join(absoluteRoot, 'config'), { recursive: true });

      const gitignore = join(absoluteRoot, '.gitignore');
      if (!existsSync(gitignore)) writeFileSync(gitignore, GITIGNORE, 'utf8');

      const defs = join(absoluteRoot, 'config', 'notes.json');
      if (!existsSync(defs)) {
        writeFileSync(defs, JSON.stringify(DEFAULT_NOTE_DEFS, null, 2) + '\n', 'utf8');
      }
    },

    notePath(type: NoteType, name: string): string {
      const trimmed = name.trim();
      if (!trimmed) throw new VaultPathError('note name is empty');
      if (trimmed.includes('/') || trimmed.includes('\\')) {
        throw new VaultPathError(`note name contains a path separator: ${name}`);
      }
      if (trimmed === '.' || trimmed === '..') {
        throw new VaultPathError(`note name is a directory reference: ${name}`);
      }
      if (trimmed.includes('\0')) {
        throw new VaultPathError(`note name contains a NUL byte: ${name}`);
      }
      if (Buffer.byteLength(`${trimmed}.md`, 'utf8') > MAX_NAME_BYTES) {
        throw new VaultPathError(`note name is too long: ${trimmed.slice(0, 40)}…`);
      }
      return `${NOTE_FOLDERS[type]}/${trimmed}.md`;
    },

    readNote(relPath: string): ParsedNote {
      return parseNote(readFileSync(safeJoin(relPath), 'utf8'));
    },

    writeNote(relPath: string, note: ParsedNote): void {
      const abs = safeJoin(relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, serializeNote(note), 'utf8');
    },

    deleteNote(relPath: string): void {
      // safeJoin first: deletion must obey the same containment and hard-link rules.
      rmSync(safeJoin(relPath), { force: true });
    },

    listNotes(): string[] {
      const out: string[] = [];
      const walk = (dir: string): void => {
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          return; // unreadable directory — skip it, never fail the whole scan
        }
        for (const entry of entries) {
          if (EXCLUDED_DIRS.has(entry)) continue;
          const abs = join(dir, entry);
          try {
            // lstat, never stat: a symlink out of the vault must never be listed.
            const stat = lstatSync(abs);
            if (stat.isSymbolicLink()) continue;
            if (stat.isDirectory()) walk(abs);
            else if (stat.isFile() && entry.endsWith('.md')) {
              // readNote refuses hard-linked files, so never list them.
              if (stat.nlink > 1) continue;
              out.push(relative(absoluteRoot, abs).split(sep).join('/'));
            }
          } catch {
            continue;
          }
        }
      };
      if (existsSync(absoluteRoot)) walk(absoluteRoot);
      return out;
    },

    noteTitle(relPath: string): string {
      return basename(relPath, '.md');
    },
  };
}
