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
