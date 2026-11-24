import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// The one exempt file asserts the UI never shows the word.
const ALLOWED = new Set(['src/components/settings-panels/__tests__/AppearanceSettings.modern.test.tsx', 'daemon/__tests__/american-spelling.test.ts']);

describe('American spelling', () => {
  it('never spells color the British way', () => {
    const root = path.resolve(__dirname, '../..');
    let out = '';
    try {
      out = execFileSync('git', ['grep', '-il', 'colour', '--', 'src', 'daemon', 'macos', 'scripts', 'packaging', 'README.md', 'CLAUDE.md', 'CHANGELOG.md'], { cwd: root, encoding: 'utf8' });
    } catch (err) {
      // git grep exits 1 when nothing matches.
      if ((err as { status?: number }).status !== 1) throw err;
    }
    const offenders = out.split('\n').filter((f) => f && !ALLOWED.has(f));
    expect(offenders).toEqual([]);
  });
});
