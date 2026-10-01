import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';

import { noBareSpawn } from '../../eslint/no-bare-spawn.mjs';

// Bare command names regressed three times (git watcher, /usage scraper MCP
// servers, limactl) before the spawn helper existed. The lint rule is what
// stops a fourth.

const linter = new Linter({ configType: 'flat' });
const lint = (code: string) =>
  linter.verify(code, [{ rules: { 'no-restricted-syntax': ['error', ...noBareSpawn] } }]).map((m) => m.message);

describe('no-bare-spawn lint restriction', () => {
  it.each([
    "execFile('limactl', ['list'], cb)",
    "execFileSync('git', ['status'])",
    "spawn('ditto', ['-xk', a, b])",
    "spawnSync('which', ['claude'])",
    "ptySpawn('bash', [], {})",
    "spawnChild('node', [])",
    "cp.execFile('afplay', [p])",
    "ptyModule.spawn('zsh', [], opts)",
    'execFile(`limactl`, [])',
  ])('rejects a bare command literal: %s', (code) => {
    expect(lint(code)).toHaveLength(1);
    expect(lint(code)[0]).toMatch(/util\/spawn/);
  });

  it.each([
    "execFile('/usr/bin/afplay', [p], cb)",
    "spawn('/usr/bin/ditto', [])",
    "deps.spawn('/bin/sh', [helper])",
    'execFile(bin, args, cb)',
    'execFile(gitBinary(), args, cb)',
    'spawn(process.execPath, [script])',
    "exec(['--version'])",
    "db.exec('VACUUM')",
    "re.exec('abc')",
    "oneShotTerminal.spawn({ binary, args })",
  ])('allows an absolute or computed command: %s', (code) => {
    expect(lint(code)).toEqual([]);
  });

  it('rejects any string or template command through a shell (execSync / exec)', () => {
    expect(lint('execSync(`"${p}" --version`)')).toHaveLength(1);
    expect(lint("execSync('ls')")).toHaveLength(1);
    expect(lint("exec('ls -l', cb)")).toHaveLength(1);
  });

  it('rejects shell: true', () => {
    expect(lint("execFile(bin, args, { shell: true })")).toHaveLength(1);
  });
});
