import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
});
