import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { buildClaudeEnv } from '../services/util/claude-env';

const HOME = '/Users/test';
const fakeDeps = (extras: { processEnv?: NodeJS.ProcessEnv } = {}) => ({
  homedir: () => HOME,
  processEnv: extras.processEnv ?? {
    PATH: '/usr/bin',
    HOME,
    SOME_OTHER: 'preserved',
  },
});

describe('buildClaudeEnv', () => {
  it('sets CLAUDE_CONFIG_DIR to the absolute resolved configDir', () => {
    const env = buildClaudeEnv('/Users/test/.claude-personal', {}, fakeDeps());
    expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/test/.claude-personal');
  });

  it('expands a leading ~/ to the home directory', () => {
    const env = buildClaudeEnv('~/.claude-work', {}, fakeDeps());
    expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/test/.claude-work');
  });

  it('expands a bare ~ to the home directory', () => {
    const env = buildClaudeEnv('~', {}, fakeDeps());
    expect(env.CLAUDE_CONFIG_DIR).toBe(HOME);
  });

  it('preserves the rest of process.env (ANTHROPIC_*, PATH, custom vars)', () => {
    const env = buildClaudeEnv(
      '/Users/test/.claude-local',
      {},
      fakeDeps({
        processEnv: {
          PATH: '/usr/bin',
          ANTHROPIC_BASE_URL: 'http://localhost:11434',
          ANTHROPIC_AUTH_TOKEN: 'ollama',
          HOME,
        },
      }),
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:11434');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('ollama');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/test/.claude-local');
  });

  it('lets caller extras override base env (e.g. per-account ANTHROPIC_BASE_URL)', () => {
    const env = buildClaudeEnv(
      '/Users/test/.claude-personal',
      { ANTHROPIC_BASE_URL: 'http://override:9999' },
      fakeDeps({
        processEnv: {
          ANTHROPIC_BASE_URL: 'http://shell-set:11434',
          HOME,
        },
      }),
    );
    expect(env.ANTHROPIC_BASE_URL).toBe('http://override:9999');
  });

  it('removes a base-env key when the override is explicitly undefined', () => {
    const env = buildClaudeEnv(
      '/Users/test/.claude-personal',
      { ANTHROPIC_AUTH_TOKEN: undefined },
      fakeDeps({
        processEnv: {
          ANTHROPIC_AUTH_TOKEN: 'leaked-token-from-shell',
          HOME,
        },
      }),
    );
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('throws on an empty configDir', () => {
    expect(() => buildClaudeEnv('', {}, fakeDeps())).toThrow(/empty/);
    expect(() => buildClaudeEnv('   ', {}, fakeDeps())).toThrow(/empty/);
  });

  it('throws on null / undefined configDir', () => {
    expect(() => buildClaudeEnv(null, {}, fakeDeps())).toThrow(/must be a string/);
    expect(() => buildClaudeEnv(undefined, {}, fakeDeps())).toThrow(/must be a string/);
  });

  it('allows ~/.claude when explicitly configured (single-account users)', () => {
    // Single-account users with only the stock ~/.claude need this to work.
    // The "no silent default" property is enforced at the resolution layer
    // (accounts.resolve() returns null if no override/rule matches), not here
    // — so any configDir that arrives at buildClaudeEnv was already chosen
    // explicitly by an account row.
    const env = buildClaudeEnv('~/.claude', {}, fakeDeps());
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(HOME, '.claude'));

    const env2 = buildClaudeEnv(path.join(HOME, '.claude'), {}, fakeDeps());
    expect(env2.CLAUDE_CONFIG_DIR).toBe(path.join(HOME, '.claude'));
  });

  it('allows the account-scoped forms (~/.claude-personal, etc.)', () => {
    expect(() =>
      buildClaudeEnv('~/.claude-personal', {}, fakeDeps()),
    ).not.toThrow();
    expect(() =>
      buildClaudeEnv('~/.claude-work', {}, fakeDeps()),
    ).not.toThrow();
    expect(() =>
      buildClaudeEnv('~/.claude-local', {}, fakeDeps()),
    ).not.toThrow();
  });

  it('uses the real process.env / homedir when deps are omitted', () => {
    // Smoke test that the default deps path works (real os.homedir + real
    // process.env). We can't assert specific values, but we can assert no
    // throw on a clearly-valid input.
    const env = buildClaudeEnv(
      path.join(os.homedir(), '.claude-personal'),
    );
    expect(env.CLAUDE_CONFIG_DIR).toMatch(/\.claude-personal$/);
  });
});
