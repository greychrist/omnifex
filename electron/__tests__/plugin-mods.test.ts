// @vitest-environment node
//
// Mod detection (sessions/mods.ts).
//
// A mod is a plugin whose hooks/hooks.json names a hooks module under
// `modules`. What it can do is read from `claude plugin validate --json`,
// whose `hooks:` and `calls:` notes are the same list the CLI shows before
// install. The capability tags are what the Session context panel leads
// with, so each one is pinned to the event or call that earns it.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readModModules,
  parseValidateReport,
  modCapabilities,
  createModInspector,
  createValidateRunner,
} from '../services/sessions/mods';

const files = (map: Record<string, string>) => (p: string): string => {
  if (p in map) return map[p];
  throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
};

describe('readModModules', () => {
  it('returns the modules a mod plugin names', () => {
    const read = files({ '/p/m/hooks/hooks.json': JSON.stringify({ modules: ['./register.ts'] }) });
    expect(readModModules('/p/m', read)).toEqual(['./register.ts']);
  });

  // Settings hooks live in the same file; only `modules` makes it a mod.
  it('is null for a plugin with settings hooks and no modules', () => {
    const read = files({ '/p/h/hooks/hooks.json': JSON.stringify({ hooks: { Stop: [] } }) });
    expect(readModModules('/p/h', read)).toBeNull();
  });

  it('is null for an empty modules array', () => {
    const read = files({ '/p/e/hooks/hooks.json': JSON.stringify({ modules: [] }) });
    expect(readModModules('/p/e', read)).toBeNull();
  });

  it('is null when there is no hooks.json or it does not parse', () => {
    expect(readModModules('/p/none', files({}))).toBeNull();
    expect(readModModules('/p/bad', files({ '/p/bad/hooks/hooks.json': '{nope' }))).toBeNull();
  });

  it('ignores non-string entries', () => {
    const read = files({ '/p/x/hooks/hooks.json': JSON.stringify({ modules: [3, './a.js'] }) });
    expect(readModModules('/p/x', read)).toEqual(['./a.js']);
  });
});

// Verbatim shape from CLI 2.1.288, trimmed.
const REPORT = JSON.stringify({
  success: true,
  contents: [
    {
      type: 'hooks',
      notes: [
        './register.ts hooks: session.start, ui.render{component=PromptHint}, command.run{command=clear|resume}, tool.call',
        './register.ts calls: $.clock.after (via hostOf), $.fs.write (via hostOf), $.ui.resolve, $.process.run',
      ],
    },
  ],
});

describe('parseValidateReport', () => {
  it('reads the hooks and calls lines, keeping matchers and dropping via notes', () => {
    expect(parseValidateReport(REPORT)).toEqual({
      hooks: ['session.start', 'ui.render{component=PromptHint}', 'command.run{command=clear|resume}', 'tool.call'],
      calls: ['clock.after', 'fs.write', 'ui.resolve', 'process.run'],
    });
  });

  // A matcher can hold a comma; splitting naively would cut it in two.
  it('does not split inside a matcher', () => {
    const r = JSON.stringify({ contents: [{ notes: ['./r.js hooks: tool.call{tool=Bash,Edit}, turn.start'] }] });
    expect(parseValidateReport(r)?.hooks).toEqual(['tool.call{tool=Bash,Edit}', 'turn.start']);
  });

  it('is null for output that is not a report', () => {
    expect(parseValidateReport('not json')).toBeNull();
    expect(parseValidateReport(JSON.stringify({ contents: [] }))).toBeNull();
  });

  it('does not split inside a via note', () => {
    const r = JSON.stringify({ contents: [{ notes: ['./r.js calls: $.fs.read (via a, b), $.http.fetch'] }] });
    expect(parseValidateReport(r)?.calls).toEqual(['fs.read', 'http.fetch']);
  });

  it('dedupes calls reached by more than one path', () => {
    const r = JSON.stringify({ contents: [{ notes: ['./r.js calls: $.fs.read, $.fs.read (via x)'] }] });
    expect(parseValidateReport(r)?.calls).toEqual(['fs.read']);
  });
});

describe('modCapabilities', () => {
  const caps = (hooks: string[], calls: string[] = []) => modCapabilities(hooks, calls);

  it('flags tool-call control from tool.call or tool.check', () => {
    expect(caps(['tool.call{tool=Bash}'])).toContain('tool-calls');
    expect(caps(['tool.check'])).toContain('tool-calls');
  });

  it('flags prompt rewriting from any prompt event', () => {
    expect(caps(['prompt.submit'])).toContain('prompts');
    expect(caps(['prompt.section'])).toContain('prompts');
  });

  it('flags processes, network, models and file writes from calls', () => {
    expect(caps([], ['process.run'])).toContain('processes');
    expect(caps([], ['http.fetch'])).toContain('network');
    expect(caps([], ['model.complete'])).toContain('models');
    expect(caps([], ['fs.write'])).toContain('writes-files');
    expect(caps([], ['prompt.submit'])).toContain('submits-prompts');
  });

  it('flags nothing for a mod that only draws', () => {
    expect(caps(['ui.render{component=Spinner}'], ['ui.invalidate'])).toEqual([]);
  });

  it('lists each capability once, in a fixed order', () => {
    expect(caps(['prompt.submit', 'tool.call', 'tool.check'], ['process.spawn', 'process.run']))
      .toEqual(['tool-calls', 'prompts', 'processes']);
  });
});

describe('createModInspector', () => {
  const mtime = (n: number) => () => n;

  it('runs validate once per plugin and hooks.json version', async () => {
    const run = vi.fn(async () => REPORT);
    let m = 1;
    const inspect = createModInspector({ run, mtimeMs: () => m });
    const a = await inspect('/p/m', '/cfg');
    await inspect('/p/m', '/cfg');
    expect(run).toHaveBeenCalledTimes(1);
    expect(a?.capabilities).toEqual(['tool-calls', 'processes', 'writes-files']);
    m = 2;
    await inspect('/p/m', '/cfg');
    expect(run).toHaveBeenCalledTimes(2);
  });

  // The mod still lists — the panel shows it as not inspected rather than
  // hiding it, since a mod we cannot read is the one worth seeing.
  it('reports null when validate fails or prints no report', async () => {
    const failing = createModInspector({ run: async () => { throw new Error('boom'); }, mtimeMs: mtime(1) });
    await expect(failing('/p/m', '/cfg')).resolves.toBeNull();
    const empty = createModInspector({ run: async () => '{}', mtimeMs: mtime(1) });
    await expect(empty('/p/m', '/cfg')).resolves.toBeNull();
  });

  it('does not cache a failure', async () => {
    let fail = true;
    const run = vi.fn(async () => { if (fail) throw new Error('x'); return REPORT; });
    const inspect = createModInspector({ run, mtimeMs: mtime(1) });
    await inspect('/p/m', '/cfg');
    fail = false;
    await expect(inspect('/p/m', '/cfg')).resolves.not.toBeNull();
  });
});

describe('createValidateRunner', () => {
  const stub = (body: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-validate-'));
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return bin;
  };

  it('passes the plugin path to `plugin validate --json`', async () => {
    const bin = stub('echo "$1 $2 $3 $4"');
    await expect(createValidateRunner(() => bin)('/p/m', '/cfg')).resolves.toBe('plugin validate --json /p/m\n');
  });

  // A plugin with errors exits 1 and still prints its report.
  it('keeps stdout from a non-zero exit', async () => {
    const bin = stub('echo \'{"success":false}\'; exit 1');
    await expect(createValidateRunner(() => bin)('/p/m', '/cfg')).resolves.toBe('{"success":false}\n');
  });

  it('rejects when there is no binary or no output', async () => {
    await expect(createValidateRunner(() => null)('/p/m', '/cfg')).rejects.toThrow('claude binary not found');
    await expect(createValidateRunner(() => stub('exit 2'))('/p/m', '/cfg')).rejects.toThrow();
  });
});
