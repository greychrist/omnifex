import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createSummaryQueryRunner,
  encodeProjectKey,
  type RunPromptFn,
} from '../services/sessions/summary-query';

// These tests cover the one-shot summary runner that wraps the SDK's
// `unstable_v2_prompt`. The hard requirement is that the subprocess's
// JSONL never lands inside the user's real project directory — every
// summary call must run in a throwaway cwd and the runner must sweep
// the resulting `<configDir>/projects/<encoded-scratch>/` directory
// before returning.

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
    const runPrompt: RunPromptFn = vi.fn(async (_msg, opts) => {
      seenCwd = opts.cwd ?? '';
      return { type: 'result', subtype: 'success', result: 'ok' } as never;
    });

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot });
    await run({ prompt: 'p', model: 'claude-haiku-4-5', configDir });

    // Stable name — not a mkdtemp-style suffix. The whole point of this
    // change is that every call writes its throwaway JSONL into the same
    // encoded `<configDir>/projects/<encoded>/` folder so we don't pile
    // up one folder per session in the user's session list.
    expect(seenCwd).toBe(path.join(tmpRoot, 'omnifex-summary-scratch'));
    expect(seenCwd).not.toBe(configDir);
  });

  it('reuses the same scratch cwd across multiple calls', async () => {
    const seen: string[] = [];
    const runPrompt: RunPromptFn = vi.fn(async (_msg, opts) => {
      seen.push(opts.cwd ?? '');
      return { type: 'result', subtype: 'success', result: '' } as never;
    });

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot });
    await run({ prompt: 'a', model: 'm', configDir });
    await run({ prompt: 'b', model: 'm', configDir });
    await run({ prompt: 'c', model: 'm', configDir });

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(1);
  });

  it('returns the assistant text on a success result', async () => {
    const runPrompt: RunPromptFn = vi.fn(
      async () => ({ type: 'result', subtype: 'success', result: 'hello world' }) as never,
    );

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot });
    const out = await run({ prompt: 'p', model: 'm', configDir });

    expect(out).toBe('hello world');
  });

  it('returns an empty string when the SDK reports an error subtype', async () => {
    const runPrompt: RunPromptFn = vi.fn(
      async () => ({ type: 'result', subtype: 'error_max_turns', errors: [] }) as never,
    );

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot });
    const out = await run({ prompt: 'p', model: 'm', configDir });

    expect(out).toBe('');
  });

  it('forwards CLAUDE_CONFIG_DIR via env', async () => {
    let seenEnv: Record<string, string | undefined> = {};
    const runPrompt: RunPromptFn = vi.fn(async (_msg, opts) => {
      seenEnv = opts.env ?? {};
      return { type: 'result', subtype: 'success', result: '' } as never;
    });

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot });
    await run({ prompt: 'p', model: 'm', configDir });

    expect(seenEnv.CLAUDE_CONFIG_DIR).toBe(configDir);
  });

  it('locks the call down: bypassPermissions, all tools disallowed, no setting sources', async () => {
    let seenOpts: Record<string, unknown> = {};
    const runPrompt: RunPromptFn = vi.fn(async (_msg, opts) => {
      seenOpts = opts as unknown as Record<string, unknown>;
      return { type: 'result', subtype: 'success', result: '' } as never;
    });

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot });
    await run({ prompt: 'p', model: 'm', configDir });

    expect(seenOpts.permissionMode).toBe('bypassPermissions');
    expect(seenOpts.allowDangerouslySkipPermissions).toBe(true);
    expect(seenOpts.disallowedTools).toEqual(['*']);
    expect(seenOpts.settingSources).toEqual([]);
  });

  it('removes the JSONL projects subdirectory the subprocess wrote', async () => {
    let projectsDir = '';
    const runPrompt: RunPromptFn = vi.fn(async (_msg, opts) => {
      // Simulate the subprocess writing a JSONL where Claude Code does:
      // <CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<uuid>.jsonl
      projectsDir = path.join(
        opts.env?.CLAUDE_CONFIG_DIR as string,
        'projects',
        encodeProjectKey(opts.cwd ?? ''),
      );
      fs.mkdirSync(projectsDir, { recursive: true });
      fs.writeFileSync(path.join(projectsDir, 'fake-uuid.jsonl'), 'x', 'utf-8');
      return { type: 'result', subtype: 'success', result: 'hi' } as never;
    });

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot });
    await run({ prompt: 'p', model: 'm', configDir });

    expect(fs.existsSync(projectsDir)).toBe(false);
  });

  it('keeps the scratch cwd directory between calls (does not delete it)', async () => {
    let seenCwd = '';
    const runPrompt: RunPromptFn = vi.fn(async (_msg, opts) => {
      seenCwd = opts.cwd ?? '';
      return { type: 'result', subtype: 'success', result: '' } as never;
    });

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot });
    await run({ prompt: 'p', model: 'm', configDir });

    // Reusing the same scratch dir is the whole point — deleting it
    // would put us right back to the per-call accumulation problem
    // (it'd be re-mkdtemp'd under a different name on the next call).
    expect(fs.existsSync(seenCwd)).toBe(true);
  });

  it('cleans up the projects dir even when the prompt throws (but keeps the scratch cwd)', async () => {
    let seenCwd = '';
    const runPrompt: RunPromptFn = vi.fn(async (_msg, opts) => {
      seenCwd = opts.cwd ?? '';
      // Pretend the subprocess started, dropped a JSONL, then crashed.
      const projectsDir = path.join(
        opts.env?.CLAUDE_CONFIG_DIR as string,
        'projects',
        encodeProjectKey(opts.cwd ?? ''),
      );
      fs.mkdirSync(projectsDir, { recursive: true });
      fs.writeFileSync(path.join(projectsDir, 'fake.jsonl'), 'x', 'utf-8');
      throw new Error('boom');
    });

    const run = createSummaryQueryRunner({ runPrompt, tmpRoot });
    await expect(run({ prompt: 'p', model: 'm', configDir })).rejects.toThrow('boom');

    // Scratch cwd stays so the next call doesn't have to re-create it.
    expect(fs.existsSync(seenCwd)).toBe(true);
    const projectsDir = path.join(configDir, 'projects', encodeProjectKey(seenCwd));
    expect(fs.existsSync(projectsDir)).toBe(false);
  });

  it('encodeProjectKey replaces path separators with dashes (matches the binary)', () => {
    expect(encodeProjectKey('/Users/foo/Repos/bar')).toBe('-Users-foo-Repos-bar');
    expect(encodeProjectKey('/var/folders/06/x/T/scratch')).toBe('-var-folders-06-x-T-scratch');
  });
});
