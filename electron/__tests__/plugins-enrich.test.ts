import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { enrichPlugin, inferScope } from '../services/sessions/plugins';

const MANIFEST = JSON.stringify({
  name: 'demo',
  version: '1.2.3',
  description: 'A demo plugin',
  author: { name: 'Acme', email: 'hi@acme.dev' },
});

function readFile(fakeFs: Record<string, string>) {
  return (p: string) => {
    const content = fakeFs[p];
    if (content == null) throw new Error('ENOENT');
    return content;
  };
}

describe('inferScope', () => {
  const configDir = '/home/me/.claude';
  const projectPath = '/repo';

  it('returns user when the plugin lives under configDir/plugins', () => {
    expect(
      inferScope('/home/me/.claude/plugins/foo', { configDir, projectPath }),
    ).toBe('user');
  });

  it('returns local when under <project>/.claude/plugins', () => {
    expect(
      inferScope('/repo/.claude/plugins/foo', { configDir, projectPath }),
    ).toBe('local');
  });

  it('returns project when under <project>/.claude-plugin', () => {
    expect(
      inferScope('/repo/.claude-plugin/nested', { configDir, projectPath }),
    ).toBe('project');
  });

  it('does not treat sibling paths as inside', () => {
    expect(
      inferScope('/home/me/.claude-sibling/plugins/foo', { configDir, projectPath }),
    ).toBe('unknown');
  });

  it('returns unknown when no options match', () => {
    expect(inferScope('/elsewhere/plug')).toBe('unknown');
  });
});

describe('enrichPlugin', () => {
  const configDir = '/home/me/.claude';

  it('merges manifest fields and infers scope', () => {
    const pluginPath = '/home/me/.claude/plugins/demo';
    const fakeFs = {
      [path.join(pluginPath, '.claude-plugin', 'plugin.json')]: MANIFEST,
    };

    const result = enrichPlugin(
      { name: 'demo', path: pluginPath, source: 'claude-plugins-official' },
      { configDir, readFile: readFile(fakeFs) },
    );

    expect(result).toEqual({
      name: 'demo',
      path: pluginPath,
      source: 'claude-plugins-official',
      scope: 'user',
      version: '1.2.3',
      description: 'A demo plugin',
      author: 'Acme',
      authorEmail: 'hi@acme.dev',
    });
  });

  it('handles string author field', () => {
    const pluginPath = '/home/me/.claude/plugins/demo';
    const manifest = JSON.stringify({ name: 'demo', author: 'Acme Inc' });
    const fakeFs = {
      [path.join(pluginPath, '.claude-plugin', 'plugin.json')]: manifest,
    };

    const result = enrichPlugin(
      { name: 'demo', path: pluginPath },
      { configDir, readFile: readFile(fakeFs) },
    );

    expect(result.author).toBe('Acme Inc');
    expect(result.authorEmail).toBeUndefined();
  });

  it('returns base fields when manifest is missing', () => {
    const result = enrichPlugin(
      { name: 'bare', path: '/somewhere/bare' },
      { readFile: readFile({}) },
    );

    expect(result).toEqual({
      name: 'bare',
      path: '/somewhere/bare',
      scope: 'unknown',
      version: undefined,
      description: undefined,
      author: undefined,
      authorEmail: undefined,
    });
  });

  it('tolerates invalid JSON without throwing', () => {
    const pluginPath = '/home/me/.claude/plugins/busted';
    const fakeFs = {
      [path.join(pluginPath, '.claude-plugin', 'plugin.json')]: '{not json',
    };

    const result = enrichPlugin(
      { name: 'busted', path: pluginPath },
      { configDir, readFile: readFile(fakeFs) },
    );

    expect(result.version).toBeUndefined();
    expect(result.scope).toBe('user');
  });
});

// Plugin manifests are attacker-adjacent input: a marketplace plugin's
// plugin.json is written by whoever published it, and OmniFex reads it
// directly rather than through the CLI. Claude Code 2.1.247 started rejecting
// marketplace names carrying control or invisible characters and escaping
// marketplace-supplied text in its own output; these cover the same ground for
// the fields we surface ourselves. Escapes are spelled out rather than pasted
// literally — the whole point is that these characters are invisible in source.
describe('enrichPlugin sanitizes manifest text', () => {
  const configDir = '/home/me/.claude';
  const pluginPath = '/home/me/.claude/plugins/demo';

  function enrichWith(
    manifest: Record<string, unknown>,
    base: { name: string; path: string; source?: string } = { name: 'demo', path: pluginPath },
  ) {
    const fakeFs = {
      [path.join(pluginPath, '.claude-plugin', 'plugin.json')]: JSON.stringify(manifest),
    };
    return enrichPlugin(base, { configDir, readFile: readFile(fakeFs) });
  }

  it('strips bidi overrides that would reverse displayed text', () => {
    // U+202E flips rendering direction, so "gpj.exe" displays as "exe.jpg".
    const result = enrichWith({ description: 'Reads \u202Egpj.exe\u202C files' });
    expect(result.description).toBe('Reads gpj.exe files');
  });

  it('strips zero-width characters used to fake a distinct identity', () => {
    const result = enrichWith({ author: 'Ac\u200Bme\u200D Inc' });
    expect(result.author).toBe('Acme Inc');
  });

  it('turns newlines and tabs into spaces instead of merging words', () => {
    // Dropping the control character outright would yield "firstsecond".
    const result = enrichWith({ description: 'first\nsecond\tthird' });
    expect(result.description).toBe('first second third');
  });

  it('strips the ESC that makes an ANSI sequence an ANSI sequence', () => {
    const result = enrichWith({ description: '\u001B[31mdanger\u001B[0m' });
    expect(result.description).toBe('[31mdanger[0m');
  });

  it('drops a field that is nothing but invisible characters', () => {
    // An empty string would render as a present-but-blank Description row.
    const result = enrichWith({ description: '\u200B\u200B', author: '   ' });
    expect(result.description).toBeUndefined();
    expect(result.author).toBeUndefined();
  });

  it('sanitizes the CLI-supplied name and source too', () => {
    const result = enrichWith(
      { version: '1.0.0' },
      { name: 'de\u200Bmo', path: pluginPath, source: 'mkt\u202Eplace' },
    );
    expect(result.name).toBe('demo');
    expect(result.source).toBe('mktplace');
  });

  it('names a plugin whose name is entirely invisible, rather than blanking it', () => {
    // An empty name renders as a nameless row the user cannot identify. The
    // CLI has the same fallback wording for unprintable marketplace names.
    const result = enrichWith(
      { version: '1.0.0' },
      { name: '\u200B\u202E', path: pluginPath },
    );
    expect(result.name).toBe('(unprintable plugin name)');
  });

  it('leaves ordinary text alone, accents and emoji included', () => {
    const result = enrichWith({
      description: 'Café tooling — ships 🚀 fast',
      author: 'Ünicode Ltd',
      version: '1.2.3-beta.1',
    });
    expect(result.description).toBe('Café tooling — ships 🚀 fast');
    expect(result.author).toBe('Ünicode Ltd');
    expect(result.version).toBe('1.2.3-beta.1');
  });
});
