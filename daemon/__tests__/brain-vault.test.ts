import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, chmodSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault, VaultPathError, type Vault } from '../services/brain/vault';
import { NoteParseError } from '../services/brain/frontmatter';
import type { ParsedNote } from '../services/brain/types';

const NOTE: ParsedNote = {
  frontmatter: {
    type: 'Subsystem', aliases: ['decider'], keywords: ['permissions'],
    created: '2026-01-01', updated: '2026-01-01', sources: [],
  },
  body: '# Permission decider\n\n## Summary\nEnforces permission changes.\n',
};

describe('vault', () => {
  let dir: string;
  let vault: Vault;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnifex-vault-'));
    vault = createVault(dir);
    vault.ensureLayout();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates every note folder', () => {
    for (const f of ['Projects', 'Subsystems', 'Topics', 'Sessions', 'Notes', 'config']) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
  });

  it('writes a .gitignore that excludes the derived index', () => {
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.omnifex/');
  });

  it('seeds config/notes.json with the note type definitions', () => {
    const defs = JSON.parse(readFileSync(join(dir, 'config', 'notes.json'), 'utf8'));
    expect(defs.map((d: { type: string }) => d.type)).toContain('Subsystem');
  });

  it('does not clobber an edited config/notes.json', () => {
    writeFileSync(join(dir, 'config', 'notes.json'), '[{"type":"Topic","folder":"Topics","template":"x","extractionGuide":"y"}]');
    vault.ensureLayout();
    const defs = JSON.parse(readFileSync(join(dir, 'config', 'notes.json'), 'utf8'));
    expect(defs).toHaveLength(1);
  });

  it('maps a type and name to a path inside the right folder', () => {
    expect(vault.notePath('Subsystem', 'Permission decider')).toBe('Subsystems/Permission decider.md');
  });

  it('rejects names containing path separators', () => {
    expect(() => vault.notePath('Topic', 'a/b')).toThrow(VaultPathError);
    expect(() => vault.notePath('Topic', 'a\\b')).toThrow(VaultPathError);
  });

  it('rejects traversal attempts', () => {
    expect(() => vault.notePath('Topic', '..')).toThrow(VaultPathError);
    expect(() => vault.notePath('Topic', '../../etc/passwd')).toThrow(VaultPathError);
  });

  it('rejects empty names', () => {
    expect(() => vault.notePath('Topic', '   ')).toThrow(VaultPathError);
  });

  it('round-trips a note through write and read', () => {
    const rel = vault.notePath('Subsystem', 'Permission decider');
    vault.writeNote(rel, NOTE);
    const read = vault.readNote(rel);
    expect(read.frontmatter.aliases).toEqual(['decider']);
    expect(read.body).toBe(NOTE.body);
  });

  it('lists notes relative to the root, excluding .git and .omnifex', () => {
    vault.writeNote(vault.notePath('Subsystem', 'A'), NOTE);
    vault.writeNote(vault.notePath('Topic', 'B'), { ...NOTE, frontmatter: { ...NOTE.frontmatter, type: 'Topic' } });
    mkdirSync(join(dir, '.omnifex'), { recursive: true });
    writeFileSync(join(dir, '.omnifex', 'stray.md'), 'x');
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'COMMIT_EDITMSG.md'), 'x');

    expect(vault.listNotes().sort()).toEqual(['Subsystems/A.md', 'Topics/B.md']);
  });

  it('derives a title from the filename', () => {
    expect(vault.noteTitle('Subsystems/Permission decider.md')).toBe('Permission decider');
  });

  it('surfaces NoteParseError for a corrupt note without affecting others', () => {
    vault.writeNote(vault.notePath('Subsystem', 'Good'), NOTE);
    writeFileSync(join(dir, 'Topics', 'Bad.md'), 'no frontmatter here\n');
    expect(() => vault.readNote('Topics/Bad.md')).toThrow(NoteParseError);
    expect(vault.readNote('Subsystems/Good.md').frontmatter.type).toBe('Subsystem');
  });

  it('rejects reads that escape the vault root', () => {
    expect(() => vault.readNote('../outside.md')).toThrow(VaultPathError);
  });

  it('rejects reads through a symlink that targets outside the vault', () => {
    const outside = mkdtempSync(join(tmpdir(), 'omnifex-outside-'));
    writeFileSync(join(outside, 'secret.md'), 'x');
    symlinkSync(outside, join(dir, 'Topics', 'link'));
    expect(() => vault.readNote('Topics/link/secret.md')).toThrow(VaultPathError);
    rmSync(outside, { recursive: true, force: true });
  });

  it('rejects writes through a symlink that targets outside the vault', () => {
    const outside = mkdtempSync(join(tmpdir(), 'omnifex-outside-'));
    symlinkSync(outside, join(dir, 'Topics', 'link'));
    expect(() => vault.writeNote('Topics/link/pwned.md', NOTE)).toThrow(VaultPathError);
    expect(existsSync(join(outside, 'pwned.md'))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('listNotes skips symlinks rather than following them', () => {
    const outside = mkdtempSync(join(tmpdir(), 'omnifex-outside-'));
    writeFileSync(join(outside, 'leaked.md'), 'x');
    symlinkSync(outside, join(dir, 'Topics', 'link'));
    vault.writeNote(vault.notePath('Subsystem', 'Real'), NOTE);
    expect(vault.listNotes()).toEqual(['Subsystems/Real.md']);
    rmSync(outside, { recursive: true, force: true });
  });

  it('listNotes survives a dangling symlink', () => {
    symlinkSync(join(dir, 'nope'), join(dir, 'Topics', 'dangling.md'));
    vault.writeNote(vault.notePath('Subsystem', 'Real'), NOTE);
    expect(vault.listNotes()).toEqual(['Subsystems/Real.md']);
  });

  it('listNotes survives an unreadable directory', () => {
    mkdirSync(join(dir, 'Topics', 'locked'));
    chmodSync(join(dir, 'Topics', 'locked'), 0o000);
    vault.writeNote(vault.notePath('Subsystem', 'Real'), NOTE);
    expect(vault.listNotes()).toEqual(['Subsystems/Real.md']);
    chmodSync(join(dir, 'Topics', 'locked'), 0o755); // so afterEach can clean up
  });

  it('rejects a note name containing a NUL byte', () => {
    expect(() => vault.notePath('Topic', 'foo\0bar')).toThrow(VaultPathError);
  });

  it('allows spaces in note names', () => {
    expect(vault.notePath('Topic', 'Claude permission rules')).toBe('Topics/Claude permission rules.md');
  });

  it('rejects a note name longer than the filesystem allows', () => {
    expect(() => vault.notePath('Topic', 'a'.repeat(300))).toThrow(VaultPathError);
  });

  describe('deleteNote', () => {
    it('removes the file', () => {
      vault.writeNote('Notes/Gone.md', NOTE);
      vault.deleteNote('Notes/Gone.md');
      expect(vault.listNotes()).not.toContain('Notes/Gone.md');
    });

    it('is a no-op for a note that is already absent', () => {
      expect(() => vault.deleteNote('Notes/Never.md')).not.toThrow();
    });

    it('refuses a path that escapes the vault', () => {
      expect(() => vault.deleteNote('../../etc/passwd')).toThrow(VaultPathError);
    });
  });

  describe('hard-linked notes', () => {
    let outside: string;

    beforeEach(() => {
      outside = mkdtempSync(join(tmpdir(), 'omnifex-outside-'));
    });

    afterEach(() => {
      rmSync(outside, { recursive: true, force: true });
    });

    it('refuses to read a note that has more than one name', () => {
      const secret = join(outside, 'secret.md');
      writeFileSync(secret, '---\ntype: Note\naliases: []\nkeywords: []\ncreated: "2026-01-01"\nupdated: "2026-01-01"\nsources: []\n---\n\nleaked\n', 'utf8');
      linkSync(secret, join(dir, 'Notes', 'Innocent.md'));

      expect(() => vault.readNote('Notes/Innocent.md')).toThrow(VaultPathError);
    });

    it('refuses to write through a hard link', () => {
      const target = join(outside, 'target.md');
      writeFileSync(target, 'original\n', 'utf8');
      linkSync(target, join(dir, 'Notes', 'Trojan.md'));

      expect(() => vault.writeNote('Notes/Trojan.md', NOTE)).toThrow(VaultPathError);
      expect(readFileSync(target, 'utf8')).toBe('original\n');
    });

    it('omits hard-linked files from listNotes', () => {
      const secret = join(outside, 'secret.md');
      writeFileSync(secret, 'x\n', 'utf8');
      vault.writeNote('Notes/Real.md', NOTE);
      linkSync(secret, join(dir, 'Notes', 'Linked.md'));

      expect(vault.listNotes()).toEqual(['Notes/Real.md']);
    });

    it('still allows an ordinary single-name note', () => {
      vault.writeNote('Notes/Ordinary.md', NOTE);
      expect(vault.readNote('Notes/Ordinary.md').body).toBe(NOTE.body);
    });
  });
});
