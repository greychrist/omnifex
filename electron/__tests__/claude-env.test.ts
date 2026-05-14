import { describe, expect, it } from 'vitest';
import path from 'node:path';
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

  it('expands a bare ~ to the home directory (but rejects on next step if it lands on ~/.claude)', () => {
    // Bare ~ → /Users/test, which is NOT ~/.claude, so it passes through.
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

  it('throws when configDir resolves to ~/.claude (the OmniFex-leak guard)', () => {
    expect(() => buildClaudeEnv('~/.claude', {}, fakeDeps())).toThrow(
      /Claude Code default location/,
    );
    expect(() => buildClaudeEnv('/Users/test/.claude', {}, fakeDeps())).toThrow(
      /Claude Code default location/,
    );
    // Even with trailing slash / extra segments resolving to the same place.
    expect(() =>
      buildClaudeEnv('/Users/test/.claude/', {}, fakeDeps()),
    ).toThrow(/Claude Code default location/);
    expect(() =>
      buildClaudeEnv('/Users/test/foo/../.claude', {}, fakeDeps()),
    ).toThrow(/Claude Code default location/);
  });

  it('does NOT reject ~/.claude-personal / ~/.claude-work (the legitimate forms)', () => {
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

  it('rejects ~/.claude even when the user explicitly types it', () => {
    // The point of this guard: even if a user enters ~/.claude in Account
    // Settings (perhaps mistakenly), refuse to spawn — surface the bug at
    // spawn time instead of silently corrupting their default Claude state.
    expect(() => buildClaudeEnv(path.join(HOME, '.claude'), {}, fakeDeps())).toThrow();
  });

  it('uses the real process.env / homedir when deps are omitted', () => {
    // Smoke test that the default deps path works (real os.homedir + real
    // process.env). We can't assert specific values, but we can assert no
    // throw on a clearly-valid input.
    const env = buildClaudeEnv(
      path.join(require('node:os').homedir(), '.claude-personal'),
    );
    expect(env.CLAUDE_CONFIG_DIR).toMatch(/\.claude-personal$/);
  });
});
