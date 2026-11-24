import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GIT_CHANGED_STYLE, GIT_UNTRACKED_STYLE, GIT_FILE_STATUS_STYLE } from '@/lib/gitStatusStyle';

// The app themes with a class on <html> (`theme-light`), not the OS appearance
// Tailwind's `dark:` follows.
describe('git status colors', () => {
  it('are theme tokens, not fixed shades', () => {
    expect(GIT_CHANGED_STYLE.className).toBe('text-git-changed');
    expect(GIT_UNTRACKED_STYLE.className).toBe('text-git-untracked');
  });

  it('are defined for every theme and darkened under .theme-light', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../../styles.css'), 'utf8');
    const block = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      return css.slice(start, css.indexOf('\n}', start));
    };
    for (const token of ['--color-git-changed', '--color-git-untracked']) {
      expect(block('@theme')).toContain(`${token}:`);
      expect(block('.theme-light')).toContain(`${token}:`);
    }
  });

  it('give every changed kind in the diff tree the changed color', () => {
    for (const kind of ['modified', 'added', 'deleted', 'renamed'] as const) {
      expect(GIT_FILE_STATUS_STYLE[kind].className).toBe(GIT_CHANGED_STYLE.className);
    }
    expect(GIT_FILE_STATUS_STYLE.untracked.className).toBe(GIT_UNTRACKED_STYLE.className);
  });
});
