import { describe, it, expect } from 'vitest';
import { languageForPath } from '@/lib/diffLanguage';

describe('languageForPath', () => {
  describe('common extensions', () => {
    it.each([
      ['a.ts', 'typescript'],
      ['a.tsx', 'tsx'],
      ['a.js', 'javascript'],
      ['a.jsx', 'jsx'],
      ['a.json', 'json'],
      ['a.md', 'markdown'],
      ['a.css', 'css'],
      ['a.py', 'python'],
      ['a.rs', 'rust'],
      ['a.go', 'go'],
      ['a.sh', 'bash'],
      ['a.yml', 'yaml'],
      ['a.yaml', 'yaml'],
      ['a.sql', 'sql'],
      ['a.html', 'markup'],
    ])('maps %s to %s', (path, expected) => {
      expect(languageForPath(path)).toBe(expected);
    });
  });

  describe('path handling', () => {
    it('uses the extension, not the directory', () => {
      expect(languageForPath('src/python/thing.ts')).toBe('typescript');
    });

    it('uses the last extension on a multi-dot name', () => {
      expect(languageForPath('a.test.ts')).toBe('typescript');
    });

    it('matches case-insensitively', () => {
      expect(languageForPath('A.TS')).toBe('typescript');
    });
  });

  describe('fallback', () => {
    it('falls back to plain text for an unknown extension', () => {
      expect(languageForPath('a.zzz')).toBe('text');
    });

    it('falls back to plain text when there is no extension', () => {
      expect(languageForPath('Makefile')).toBe('text');
    });

    it('does not treat a dotfile name as an extension', () => {
      // `.gitignore` has no extension — the leading dot starts the name.
      expect(languageForPath('.gitignore')).toBe('text');
    });

    it('falls back to plain text for an empty path', () => {
      expect(languageForPath('')).toBe('text');
    });
  });
});
