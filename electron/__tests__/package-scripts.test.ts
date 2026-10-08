import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const scripts = (
  JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

/**
 * better-sqlite3's install is `prebuild-install || node-gyp rebuild`, and
 * prebuild-install unpacks over the existing .node IN PLACE. macOS SIGKILLs
 * any process that loads a signed binary rewritten in place while another
 * process has it mapped (Code Signature Invalid) — so prebuild-install's own
 * check died, `||` fell back to a ~12 s source build, and a crash report was
 * written every run. Deleting first makes the new file a new inode; a process
 * still holding the old one keeps working.
 */
describe('pretest scripts', () => {
  it.each(['pretest', 'pretest:watch', 'pretest:coverage'])(
    '%s deletes the better-sqlite3 binary before rebuilding it',
    (name) => {
      const script = scripts[name];
      const rm = script.indexOf('rm -f node_modules/better-sqlite3/build/Release/better_sqlite3.node');
      const rebuild = script.indexOf('npm rebuild better-sqlite3 node-pty');
      expect(rm).toBeGreaterThanOrEqual(0);
      expect(rebuild).toBeGreaterThan(rm);
    },
  );
});
