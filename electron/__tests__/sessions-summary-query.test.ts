import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import {
  createSummaryQueryRunner,
  encodeProjectKey,
  runCliOnce,
  type RunPromptFn,
} from '../services/sessions/summary-query';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn() };
});
const mockedSpawn = vi.mocked(spawn);

// These tests cover the one-shot summary runner that wraps a `claude -p`
// subprocess invocation. The hard requirement is that the CLI's JSONL
// never lands inside the user's real project directory — every summary
// call must run in a throwaway cwd and the runner must sweep the
// resulting `<configDir>/projects/<encoded-scratch>/` directory before
// returning.

describe('createSummaryQueryRunner', () => {
  let tmpRoot: string;
  let configDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-sumq-root-'));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-sumq-config-'));
    fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('runs the prompt in a stable shared scratch cwd under tmpRoot, never the configDir', async () => {
    let seenCwd = '';
    const runPrompt: RunPromptFn = vi.fn(async (params) => {
      seenCwd = params.cwd;
      return 'ok';
    });

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot });
    await run({ prompt: 'p', model: 'claude-haiku-4-5', configDir });

    expect(seenCwd).toBe(path.join(tmpRoot, 'omnifex-summary-scratch'));
    expect(seenCwd).not.toBe(configDir);
  });

  it('reuses the same scratch cwd across multiple calls', async () => {
    const seen: string[] = [];
    const runPrompt: RunPromptFn = vi.fn(async (params) => {
      seen.push(params.cwd);
      return '';
    });

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot });
    await run({ prompt: 'a', model: 'm', configDir });
    await run({ prompt: 'b', model: 'm', configDir });
    await run({ prompt: 'c', model: 'm', configDir });

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(1);
  });

  it('returns the runner output verbatim', async () => {
    const runPrompt: RunPromptFn = vi.fn(async () => 'hello world');

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot });
    const out = await run({ prompt: 'p', model: 'm', configDir });

    expect(out).toBe('hello world');
  });

  it('returns an empty string when the CLI replies with an empty result', async () => {
    const runPrompt: RunPromptFn = vi.fn(async () => '');
    const run = createSummaryQueryRunner({ runPrompt, tmpRoot });
    const out = await run({ prompt: 'p', model: 'm', configDir });
    expect(out).toBe('');
  });

  it('forwards configDir + model + prompt to the runner', async () => {
    let seen: Parameters<RunPromptFn>[0] | null = null;
    const runPrompt: RunPromptFn = vi.fn(async (params) => {
      seen = params;
      return '';
    });

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot });
    await run({ prompt: 'summarize this', model: 'claude-haiku-4-5', configDir });

    expect(seen).not.toBeNull();
    expect(seen!.configDir).toBe(configDir);
    expect(seen!.model).toBe('claude-haiku-4-5');
    expect(seen!.prompt).toBe('summarize this');
  });

  it('removes the JSONL projects subdirectory the subprocess wrote', async () => {
    let projectsDir = '';
    const runPrompt: RunPromptFn = vi.fn(async (params) => {
      projectsDir = path.join(
        params.configDir,
        'projects',
        encodeProjectKey(params.cwd),
      );
      fs.mkdirSync(projectsDir, { recursive: true });
      fs.writeFileSync(path.join(projectsDir, 'fake-uuid.jsonl'), 'x', 'utf-8');
      return 'hi';
    });

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot });
    await run({ prompt: 'p', model: 'm', configDir });

    expect(fs.existsSync(projectsDir)).toBe(false);
  });

  it('keeps the scratch cwd directory between calls (does not delete it)', async () => {
    let seenCwd = '';
    const runPrompt: RunPromptFn = vi.fn(async (params) => {
      seenCwd = params.cwd;
      return '';
    });

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot });
    await run({ prompt: 'p', model: 'm', configDir });

    expect(fs.existsSync(seenCwd)).toBe(true);
  });

  it('cleans up the projects dir even when the prompt throws (but keeps the scratch cwd)', async () => {
    let seenCwd = '';
    const runPrompt: RunPromptFn = vi.fn(async (params) => {
      seenCwd = params.cwd;
      const projectsDir = path.join(
        params.configDir,
        'projects',
        encodeProjectKey(params.cwd),
      );
      fs.mkdirSync(projectsDir, { recursive: true });
      fs.writeFileSync(path.join(projectsDir, 'fake.jsonl'), 'x', 'utf-8');
      throw new Error('boom');
    });

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot });
    await expect(run({ prompt: 'p', model: 'm', configDir })).rejects.toThrow('boom');

    expect(fs.existsSync(seenCwd)).toBe(true);
    const projectsDir = path.join(configDir, 'projects', encodeProjectKey(seenCwd));
    expect(fs.existsSync(projectsDir)).toBe(false);
  });

  it('encodeProjectKey replaces path separators with dashes (matches the binary)', () => {
    expect(encodeProjectKey('/Users/foo/Repos/bar')).toBe('-Users-foo-Repos-bar');
    expect(encodeProjectKey('/var/folders/06/x/T/scratch')).toBe('-var-folders-06-x-T-scratch');
  });

  it('passes the resolved claude binary through to runPrompt', async () => {
    let seenBinary: string | null = null;
    const runPrompt: RunPromptFn = vi.fn(async (params) => {
      seenBinary = params.claudeBinary;
      return '';
    });

    const run = createSummaryQueryRunner({
      runPrompt,
      tmpRoot,
      resolveClaudeBinary: () => '/usr/local/bin/claude',
    });
    await run({ prompt: 'p', model: 'm', configDir });

    expect(seenBinary).toBe('/usr/local/bin/claude');
  });

  it('throws a clear error when no Claude binary can be resolved', async () => {
    const runPrompt: RunPromptFn = vi.fn(async () => '');

    const run = createSummaryQueryRunner({
      runPrompt,
      tmpRoot,
      resolveClaudeBinary: () => null,
    });

    await expect(run({ prompt: 'p', model: 'm', configDir })).rejects.toThrow(
      /Claude binary not found/i,
    );
    expect(runPrompt).not.toHaveBeenCalled();
  });
});

describe('runCliOnce (default RunPromptFn)', () => {
  interface FakeChild extends EventEmitter {
    stdout: Readable;
    stderr: Readable;
  }

  function makeFakeChild(): FakeChild {
    const e = new EventEmitter() as FakeChild;
    e.stdout = new Readable({ read() {} });
    e.stderr = new Readable({ read() {} });
    return e;
  }

  async function flush(): Promise<void> {
    await new Promise((r) => setImmediate(r));
  }

  beforeEach(() => {
    mockedSpawn.mockReset();
  });

  it('spawns claude with -p, --output-format json, --model, and the right env+cwd', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);

    const pending = runCliOnce({
      claudeBinary: '/usr/local/bin/claude',
      prompt: 'summarize this',
      model: 'claude-haiku-4-5',
      configDir: '/tmp/conf',
      cwd: '/tmp/scratch',
    });

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockedSpawn.mock.calls[0] as [
      string,
      string[],
      { cwd: string; env: NodeJS.ProcessEnv },
    ];
    expect(cmd).toBe('/usr/local/bin/claude');
    expect(args).toEqual(
      expect.arrayContaining([
        '-p',
        'summarize this',
        '--output-format',
        'json',
        '--model',
        'claude-haiku-4-5',
        '--permission-mode',
        'bypassPermissions',
      ]),
    );
    expect(opts.cwd).toBe('/tmp/scratch');
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe('/tmp/conf');

    fake.stdout.push(JSON.stringify({ result: 'a short summary.' }));
    fake.stdout.push(null);
    await flush();
    fake.emit('exit', 0, null);
    await expect(pending).resolves.toBe('a short summary.');
  });

  it('rejects with stderr context on non-zero exit', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);

    const pending = runCliOnce({
      claudeBinary: '/usr/local/bin/claude',
      prompt: 'p',
      configDir: '/tmp/conf',
      cwd: '/tmp/scratch',
    });
    const assertion = expect(pending).rejects.toThrow(/exited 2.*auth failed/);

    fake.stderr.push('auth failed\n');
    await flush();
    fake.emit('exit', 2, null);
    await assertion;
  });

  it('rejects on non-JSON stdout', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);

    const pending = runCliOnce({
      claudeBinary: '/usr/local/bin/claude',
      prompt: 'p',
      configDir: '/tmp/conf',
      cwd: '/tmp/scratch',
    });
    const assertion = expect(pending).rejects.toThrow(/non-JSON/);

    fake.stdout.push('not json');
    await flush();
    fake.emit('exit', 0, null);
    await assertion;
  });
});
