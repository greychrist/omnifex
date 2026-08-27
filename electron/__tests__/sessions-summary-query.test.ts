import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import {
  createSummaryQueryRunner,
  runCliOnce,
  type RunPromptFn,
} from '../services/sessions/summary-query';
import { encodeProjectId } from '../services/project-paths';
import type { CliRunResult } from '../services/sessions/summary-query';

/**
 * A `claude -p` result carrying just the reply.
 *
 * The runner now returns the CLI's cost accounting alongside the text (the
 * Brain records what each indexing run cost). These suites are about the text,
 * so they wrap it here rather than restating five null fields per fixture.
 */
function reply(text: string, cost: Partial<CliRunResult> = {}): CliRunResult {
  return {
    result: text,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    durationMs: null,
    ...cost,
  };
}

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn() };
});
const mockedSpawn = vi.mocked(spawn);

// These tests cover the one-shot summary runner that wraps a `claude -p`
// subprocess invocation. Two hard requirements: the CLI's JSONL never lands
// inside the user's real project directory, and it is never DELETED — every
// one of these calls is billed, and the transcript is the only local record
// that it happened. The runner moves it to the internal archive and leaves
// `<configDir>/projects/<encoded-scratch>/` empty behind it.

describe('createSummaryQueryRunner', () => {
  let tmpRoot: string;
  let configDir: string;
  let archiveRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-sumq-root-'));
    archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-sumq-archive-'));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-sumq-config-'));
    fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  });

  it('runs the prompt in a stable shared scratch cwd under tmpRoot, never the configDir', async () => {
    let seenCwd = '';
    const runPrompt: RunPromptFn = vi.fn(async (params) => {
      seenCwd = params.cwd;
      return reply('ok');
    });

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot, archiveRoot, resolveAccountName: () => 'Work' });
    await run({ prompt: 'p', model: 'claude-haiku-4-5', configDir, kind: 'session-summarization' });

    expect(seenCwd).toBe(path.join(tmpRoot, 'omnifex-summary-scratch'));
    expect(seenCwd).not.toBe(configDir);
  });

  it('reuses the same scratch cwd across multiple calls', async () => {
    const seen: string[] = [];
    const runPrompt: RunPromptFn = vi.fn(async (params) => {
      seen.push(params.cwd);
      return reply('');
    });

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot, archiveRoot, resolveAccountName: () => 'Work' });
    await run({ prompt: 'a', model: 'm', configDir, kind: 'session-summarization' });
    await run({ prompt: 'b', model: 'm', configDir, kind: 'session-summarization' });
    await run({ prompt: 'c', model: 'm', configDir, kind: 'session-summarization' });

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(1);
  });

  it('returns the runner output verbatim', async () => {
    const runPrompt: RunPromptFn = vi.fn(async () => reply('hello world'));

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot, archiveRoot, resolveAccountName: () => 'Work' });
    const out = await run({ prompt: 'p', model: 'm', configDir, kind: 'session-summarization' });

    // The reply now travels alongside the CLI's cost accounting.
    expect(out.result).toBe('hello world');
  });

  it('returns an empty string when the CLI replies with an empty result', async () => {
    const runPrompt: RunPromptFn = vi.fn(async () => reply(''));
    const run = createSummaryQueryRunner({ runPrompt, tmpRoot, archiveRoot, resolveAccountName: () => 'Work' });
    const out = await run({ prompt: 'p', model: 'm', configDir, kind: 'session-summarization' });
    expect(out.result).toBe('');
  });

  it('forwards configDir + model + prompt to the runner', async () => {
    let seen: Parameters<RunPromptFn>[0] | null = null;
    const runPrompt: RunPromptFn = vi.fn(async (params) => {
      seen = params;
      return reply('');
    });

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot, archiveRoot, resolveAccountName: () => 'Work' });
    await run({ prompt: 'summarize this', model: 'claude-haiku-4-5', configDir, kind: 'session-summarization' });

    expect(seen).not.toBeNull();
    expect(seen!.configDir).toBe(configDir);
    expect(seen!.model).toBe('claude-haiku-4-5');
    expect(seen!.prompt).toBe('summarize this');
  });

  it('archives the JSONL instead of deleting it, and clears the projects subdirectory', async () => {
    let projectsDir = '';
    const runPrompt: RunPromptFn = vi.fn(async (params) => {
      projectsDir = path.join(
        params.configDir,
        'projects',
        encodeProjectId(params.cwd),
      );
      fs.mkdirSync(projectsDir, { recursive: true });
      fs.writeFileSync(path.join(projectsDir, 'fake-uuid.jsonl'), 'x', 'utf-8');
      return reply('hi');
    });

    const run = createSummaryQueryRunner({
      runPrompt, tmpRoot, archiveRoot,
      resolveAccountName: () => 'Work',
      now: () => new Date('2026-08-26T12:00:00Z'),
    });
    await run({ prompt: 'p', model: 'm', configDir, kind: 'session-summarization' });

    // Gone from where the CLI put it...
    expect(fs.existsSync(projectsDir)).toBe(false);
    // ...but kept, under account / kind / date.
    const archived = path.join(
      archiveRoot, 'Work', 'session-summarization', '2026-08-26', 'fake-uuid.jsonl',
    );
    expect(fs.existsSync(archived)).toBe(true);
    expect(fs.readFileSync(archived, 'utf-8')).toBe('x');
  });

  // Attribution comes from the config dir the run was launched with, never
  // from resolve(). An account that cannot be resolved must still keep its
  // transcript -- an unattributed record beats a deleted one.
  it('parks an unresolvable account under a visible placeholder', async () => {
    const runPrompt: RunPromptFn = vi.fn(async (params) => {
      const dir = path.join(params.configDir, 'projects', encodeProjectId(params.cwd));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'u.jsonl'), 'x', 'utf-8');
      return reply('hi');
    });
    const run = createSummaryQueryRunner({
      runPrompt, tmpRoot, archiveRoot,
      resolveAccountName: () => null,
      now: () => new Date('2026-08-26T12:00:00Z'),
    });
    await run({ prompt: 'p', model: 'm', configDir, kind: 'brain-index' });
    expect(fs.existsSync(
      path.join(archiveRoot, '_unresolved', 'brain-index', '2026-08-26', 'u.jsonl'),
    )).toBe(true);
  });

  it('keeps the scratch cwd directory between calls (does not delete it)', async () => {
    let seenCwd = '';
    const runPrompt: RunPromptFn = vi.fn(async (params) => {
      seenCwd = params.cwd;
      return reply('');
    });

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot, archiveRoot, resolveAccountName: () => 'Work' });
    await run({ prompt: 'p', model: 'm', configDir, kind: 'session-summarization' });

    expect(fs.existsSync(seenCwd)).toBe(true);
  });

  it('cleans up the projects dir even when the prompt throws (but keeps the scratch cwd)', async () => {
    let seenCwd = '';
    const runPrompt: RunPromptFn = vi.fn(async (params) => {
      seenCwd = params.cwd;
      const projectsDir = path.join(
        params.configDir,
        'projects',
        encodeProjectId(params.cwd),
      );
      fs.mkdirSync(projectsDir, { recursive: true });
      fs.writeFileSync(path.join(projectsDir, 'fake.jsonl'), 'x', 'utf-8');
      throw new Error('boom');
    });

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot, archiveRoot, resolveAccountName: () => 'Work' });
    await expect(run({ prompt: 'p', model: 'm', configDir, kind: 'session-summarization' })).rejects.toThrow('boom');

    expect(fs.existsSync(seenCwd)).toBe(true);
    const projectsDir = path.join(configDir, 'projects', encodeProjectId(seenCwd));
    expect(fs.existsSync(projectsDir)).toBe(false);
  });

  it('encodeProjectId replaces path separators with dashes (matches the binary)', () => {
    expect(encodeProjectId('/Users/foo/Repos/bar')).toBe('-Users-foo-Repos-bar');
    expect(encodeProjectId('/var/folders/06/x/T/scratch')).toBe('-var-folders-06-x-T-scratch');
  });

  it('encodeProjectId replaces every non-alphanumeric, not just the separator', () => {
    // The CLI sanitizes with /[^a-zA-Z0-9]/g, so dots, underscores and spaces
    // all collapse to '-'. Replacing only '/' pointed us at directories the
    // CLI never wrote.
    expect(encodeProjectId('/Users/foo/my_app.v2')).toBe('-Users-foo-my-app-v2');
    expect(encodeProjectId('/Users/foo/My Project')).toBe('-Users-foo-My-Project');
    expect(encodeProjectId('/Users/foo/a+b@c')).toBe('-Users-foo-a-b-c');
  });

  it('encodeProjectId leaves a 200-char key untruncated', () => {
    const p = '/' + 'a'.repeat(199);
    expect(encodeProjectId(p)).toBe('-' + 'a'.repeat(199));
    expect(encodeProjectId(p)).toHaveLength(200);
  });

  it('encodeProjectId truncates past 200 chars and appends the CLI hash', () => {
    const p = '/' + 'a'.repeat(200);
    const encoded = encodeProjectId(p);
    expect(encoded.slice(0, 200)).toBe('-' + 'a'.repeat(199));
    expect(encoded).toMatch(/^-a{199}-[0-9a-z]+$/);
  });

  it('encodeProjectId matches a directory name observed from CLI 2.1.224', () => {
    // Ground truth: ran `claude -p` in this cwd with a scratch CLAUDE_CONFIG_DIR
    // and read back the directory the binary created under projects/.
    const cwd =
      '/private/tmp/omnifex-encoder-probe/seg_one.v1/seg_two.v2/seg_three.v3/' +
      'seg_four.v4/seg_five.v5/seg_six.v6/seg_seven.v7/seg_eight.v8/seg_nine.v9/' +
      'seg_ten.v10/seg_eleven.v11/seg_twelve.v12/seg_thirteen.v13/' +
      'seg_fourteen.v14/seg_fifteen.v15';
    expect(encodeProjectId(cwd)).toBe(
      '-private-tmp-omnifex-encoder-probe-seg-one-v1-seg-two-v2-seg-three-v3-' +
        'seg-four-v4-seg-five-v5-seg-six-v6-seg-seven-v7-seg-eight-v8-seg-nine-v9-' +
        'seg-ten-v10-seg-eleven-v11-seg-twelve-v12-seg-thirteen-v1-vflzar',
    );
  });

  it('encodeProjectId NFC-normalizes before sanitizing and hashing', () => {
    // 'e' + combining acute vs precomposed 'e-acute': same directory either way.
    expect(encodeProjectId('/Users/foo/cafe\u0301')).toBe(encodeProjectId('/Users/foo/caf\u00e9'));
  });

  it('passes the resolved claude binary through to runPrompt', async () => {
    let seenBinary: string | null = null;
    const runPrompt: RunPromptFn = vi.fn(async (params) => {
      seenBinary = params.claudeBinary;
      return reply('');
    });

    const run = createSummaryQueryRunner({
      runPrompt,
      tmpRoot,
      archiveRoot,
      resolveAccountName: () => 'Work',
      resolveClaudeBinary: () => '/usr/local/bin/claude',
    });
    await run({ prompt: 'p', model: 'm', configDir, kind: 'session-summarization' });

    expect(seenBinary).toBe('/usr/local/bin/claude');
  });

  it('throws a clear error when no Claude binary can be resolved', async () => {
    const runPrompt: RunPromptFn = vi.fn(async () => reply(''));

    const run = createSummaryQueryRunner({
      runPrompt,
      tmpRoot,
      archiveRoot,
      resolveAccountName: () => 'Work',
      resolveClaudeBinary: () => null,
    });

    await expect(run({ prompt: 'p', model: 'm', configDir, kind: 'session-summarization' })).rejects.toThrow(
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
    await expect(pending).resolves.toMatchObject({ result: 'a short summary.' });
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
  /**
   * The cost half of the envelope. Every `claude -p` call already returns this;
   * the runner parsed out `result` and dropped the rest, so the Brain could
   * spend without ever being able to say what it spent.
   *
   * Field names verified against the CLI's own output on 2.1.229.
   */
  it('lifts the CLI cost and usage out of the envelope', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);

    const pending = runCliOnce({
      claudeBinary: '/bin/claude', prompt: 'p', configDir: '/cfg', cwd: '/tmp/scratch',
    });
    fake.stdout.push(JSON.stringify({
      result: 'ok',
      total_cost_usd: 0.020333,
      duration_ms: 4589,
      usage: {
        input_tokens: 10,
        output_tokens: 315,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 9374,
      },
    }));
    fake.stdout.push(null);
    await flush();
    fake.emit('exit', 0, null);

    await expect(pending).resolves.toEqual({
      result: 'ok',
      costUsd: 0.020333,
      inputTokens: 10,
      outputTokens: 315,
      cacheReadTokens: 0,
      cacheCreationTokens: 9374,
      durationMs: 4589,
    });
  });

  it('reports an absent figure as unknown, never as free', async () => {
    // A future CLI that stops emitting a field must not have that read as a
    // confident zero — "$0.00" is a claim, and it would be a false one.
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);

    const pending = runCliOnce({
      claudeBinary: '/bin/claude', prompt: 'p', configDir: '/cfg', cwd: '/tmp/scratch',
    });
    fake.stdout.push(JSON.stringify({ result: 'ok' }));
    fake.stdout.push(null);
    await flush();
    fake.emit('exit', 0, null);

    const out = await pending;
    expect(out.costUsd).toBeNull();
    expect(out.inputTokens).toBeNull();
    expect(out.durationMs).toBeNull();
  });

  it('ignores a non-numeric cost rather than coercing it', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);

    const pending = runCliOnce({
      claudeBinary: '/bin/claude', prompt: 'p', configDir: '/cfg', cwd: '/tmp/scratch',
    });
    fake.stdout.push(JSON.stringify({ result: 'ok', total_cost_usd: '0.02' }));
    fake.stdout.push(null);
    await flush();
    fake.emit('exit', 0, null);

    expect((await pending).costUsd).toBeNull();
  });
});
