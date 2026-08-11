import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, dirname, basename, relative, resolve, sep } from 'node:path';
import { parseNote, serializeNote } from './frontmatter';
import { NOTE_FOLDERS, type NoteType, type ParsedNote } from './types';

/** Thrown when a note name or relative path would escape the vault root. */
export class VaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultPathError';
  }
}

/** Directories never scanned for notes. */
const EXCLUDED_DIRS = new Set(['.git', '.omnifex']);

/** POSIX NAME_MAX. Longer names fail at the syscall with a raw ENAMETOOLONG. */
const MAX_NAME_BYTES = 255;

/**
 * Seed note-type definitions written to config/notes.json on first use. Kept
 * config-driven (Rowboat's note_system.ts pattern) so adding a type is an edit
 * rather than a code change, and so the template and the extraction prompt
 * render from one source and cannot drift.
 */
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
  listNotes(): string[];
  noteTitle(relPath: string): string;
}

export function createVault(root: string): Vault {
  const absoluteRoot = resolve(root);

  /**
   * Resolve the real root once. Symlink checks compare against this, not the
   * lexical root, so a vault reached via a symlinked path still works.
   */
  let cachedRealRoot: string | null = null;
  function realRoot(): string {
    if (cachedRealRoot === null) {
      cachedRealRoot = existsSync(absoluteRoot) ? realpathSync(absoluteRoot) : absoluteRoot;
    }
    return cachedRealRoot;
  }

  /**
   * Resolve a vault-relative path, refusing anything that escapes the root.
   *
   * A lexical prefix check is not sufficient: a symlink INSIDE the vault whose
   * target is outside it passes the string test, because dereferencing happens
   * in the OS afterwards. So we also resolve the deepest EXISTING ancestor with
   * realpathSync and re-check. The ancestor walk is what makes this work for
   * writes to files that do not exist yet.
   */
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
      if (trimmed.includes(' ')) {
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
            // lstat, not stat: a symlink is never followed, so a link pointing
            // outside the vault can neither be listed nor round-tripped back
            // into readNote/writeNote by a caller enumerating the vault.
            const stat = lstatSync(abs);
            if (stat.isSymbolicLink()) continue;
            if (stat.isDirectory()) walk(abs);
            else if (stat.isFile() && entry.endsWith('.md')) {
              out.push(relative(absoluteRoot, abs).split(sep).join('/'));
            }
          } catch {
            continue; // unstat-able entry (dangling link, race) — skip it
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
