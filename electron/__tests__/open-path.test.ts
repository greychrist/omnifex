import { describe, it, expect } from 'vitest';
import { resolveLinkPath, planOpenPath, type PathStat } from '../services/open-path';

const home = '/Users/me';
const cwd = '/Users/me/Repos/work/management';

describe('resolveLinkPath', () => {
  it('resolves a relative path against the session cwd', () => {
    expect(resolveLinkPath('reports/draft.md', { cwd, homeDir: home })).toBe(`${cwd}/reports/draft.md`);
  });

  it('keeps an absolute path', () => {
    expect(resolveLinkPath('/tmp/a.md', { cwd, homeDir: home })).toBe('/tmp/a.md');
  });

  it('expands ~', () => {
    expect(resolveLinkPath('~/notes.md', { homeDir: home })).toBe('/Users/me/notes.md');
  });

  it('strips a :line and :line:col suffix', () => {
    expect(resolveLinkPath('src/foo.ts:42', { cwd, homeDir: home })).toBe(`${cwd}/src/foo.ts`);
    expect(resolveLinkPath('src/foo.ts:42:7', { cwd, homeDir: home })).toBe(`${cwd}/src/foo.ts`);
  });

  it('decodes percent-encoding react-markdown applies to hrefs', () => {
    expect(resolveLinkPath('/tmp/my%20file.md', { homeDir: home })).toBe('/tmp/my file.md');
  });

  it('accepts a file:// url', () => {
    expect(resolveLinkPath('file:///tmp/a.md', { homeDir: home })).toBe('/tmp/a.md');
  });

  it('returns null for a relative path with no cwd', () => {
    expect(resolveLinkPath('reports/draft.md', { homeDir: home })).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(resolveLinkPath('  ', { cwd, homeDir: home })).toBeNull();
  });
});

const file = (mode = 0o644): PathStat => ({ isDirectory: () => false, mode });
const dir = (): PathStat => ({ isDirectory: () => true, mode: 0o755 });

describe('planOpenPath', () => {
  it('opens an existing document', async () => {
    const plan = await planOpenPath('reports/draft.md', { cwd, homeDir: home, stat: async () => file() });
    expect(plan).toEqual({ kind: 'open', path: `${cwd}/reports/draft.md` });
  });

  it('opens a folder (Finder shows it)', async () => {
    const plan = await planOpenPath('/tmp/x', { homeDir: home, stat: async () => dir() });
    expect(plan).toEqual({ kind: 'open', path: '/tmp/x' });
  });

  it('reports a missing file', async () => {
    const plan = await planOpenPath('reports/gone.md', { cwd, homeDir: home, stat: async () => null });
    expect(plan).toEqual({ kind: 'error', message: `File not found: ${cwd}/reports/gone.md` });
  });

  it('reports a relative path with no session directory', async () => {
    const plan = await planOpenPath('reports/draft.md', { homeDir: home, stat: async () => file() });
    expect(plan.kind).toBe('error');
  });

  // Claude writes these paths. A click must never run something.
  it('reveals an executable file instead of opening it', async () => {
    const plan = await planOpenPath('/tmp/run', { homeDir: home, stat: async () => file(0o755) });
    expect(plan).toEqual({ kind: 'reveal', path: '/tmp/run' });
  });

  it.each(['x.app', 'x.command', 'x.sh', 'x.terminal', 'x.workflow', 'x.pkg', 'x.scpt', 'x.py', 'x.jar'])(
    'reveals %s instead of opening it, even without the executable bit',
    async (name) => {
      const stat = async () => (name.endsWith('.app') ? dir() : file());
      const plan = await planOpenPath(`/tmp/${name}`, { homeDir: home, stat });
      expect(plan).toEqual({ kind: 'reveal', path: `/tmp/${name}` });
    },
  );
});
