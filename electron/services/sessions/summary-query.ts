import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { findSystemClaudeBinary } from './binary';
import { buildClaudeEnv } from '../util/claude-env';

// ---------------------------------------------------------------------------
// One-shot summary runner — `claude -p <prompt> --output-format json`
//
// Background:
//   The Claude Code CLI always persists a JSONL under
//     <CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<uuid>.jsonl
//   regardless of which CLI mode you invoke. Earlier the summary path
//   drove the CLI with the real project path as `cwd`, leaving throwaway
//   one-message sessions in the user's real project session list.
//
//   The summary path now invokes `claude -p` (print mode) wrapped in
//   `runCliOnce` (below) for one-shot await-and-go ergonomics, with the
//   following guard rails:
//     - Pins every call to a single STABLE scratch cwd
//       `<os.tmpdir()>/omnifex-summary-scratch`. The encoded form is the
//       same on every call, so we don't accumulate one
//       `<configDir>/projects/-var-folders-...-omnifex-summary-XXXXX/`
//       folder per call. After each call we wipe the contents of the
//       encoded projects dir.
//     - `--permission-mode bypassPermissions` skips approval prompts —
//       summarization runs as a one-shot, no human in the loop.
//     - `--disallowed-tools '*'` blocks every tool — the summary prompt
//       has no need to read or write.
//
//   Concurrency note: if two summary calls overlap, they share the same
//   projects dir. The cleanup `rm -rf` of one call may unlink the other's
//   in-flight JSONL — that's benign on POSIX (the subprocess's open fd
//   survives the unlink and the file finalises as unlinked when the
//   subprocess exits). Summary transcripts are throwaway, so losing one
//   to a race has no observable effect.
// ---------------------------------------------------------------------------

const SCRATCH_DIR_NAME = 'omnifex-summary-scratch';

export interface SummaryQueryOptions {
  prompt: string;
  /** CLI model id, e.g. 'claude-haiku-4-5'. */
  model: string;
  /** The resolved account's CLAUDE_CONFIG_DIR — auth lives here. */
  configDir: string;
}

export interface RunPromptParams {
  /** Resolved claude binary path. */
  claudeBinary: string;
  /** The summary prompt to send. */
  prompt: string;
  /** Optional model id. */
  model?: string;
  /** Resolved CLAUDE_CONFIG_DIR for the call. */
  configDir: string;
  /** Pinned scratch cwd so the JSONL stays in a predictable, sweep-able location. */
  cwd: string;
}

/** Subset of the CLI runner surface we depend on — exposed for testing. */
export type RunPromptFn = (params: RunPromptParams) => Promise<string>;

/**
 * Spawn `claude -p <prompt> --output-format json` and resolve with the
 * `result` field of the CLI's JSON reply. Rejects on non-zero exit with
 * a message that includes captured stderr. Exposed as a default
 * implementation of `RunPromptFn` for the runner factory.
 */
export async function runCliOnce(p: RunPromptParams): Promise<string> {
  const args: string[] = ['-p', p.prompt, '--output-format', 'json'];
  if (p.model) args.push('--model', p.model);
  args.push('--permission-mode', 'bypassPermissions');
  args.push('--disallowed-tools', '*');

  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    p.claudeBinary,
    args,
    {
      cwd: p.cwd,
      env: buildClaudeEnv(p.configDir),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ) as ChildProcessByStdio<null, Readable, Readable>;

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer | string) => {
    stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  });

  return await new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `claude -p exited ${code ?? 'null'}${
              signal ? ` (signal ${signal})` : ''
            }: ${stderr.trim().slice(0, 500)}`,
          ),
        );
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { result?: unknown };
        const result = typeof parsed?.result === 'string' ? parsed.result.trim() : '';
        resolve(result);
      } catch (e) {
        reject(
          new Error(
            `claude -p returned non-JSON: ${stdout.slice(0, 200)} (parse error: ${
              e instanceof Error ? e.message : String(e)
            })`,
          ),
        );
      }
    });
  });
}

export interface SummaryQueryDeps {
  /**
   * Defaults to `runCliOnce`. Injected in tests so they don't need to
   * actually spawn the CLI.
   */
  runPrompt?: RunPromptFn;
  /** Defaults to `os.tmpdir()`. Injected in tests. */
  tmpRoot?: string;
  /**
   * Resolve the Claude Code binary. Defaults to `findSystemClaudeBinary`
   * (system installs → app-bundled per-platform binary). Injected in
   * tests so they can pin to a fake path without depending on disk state.
   */
  resolveClaudeBinary?: () => string | null;
}

/**
 * Mirrors how the Claude Code subprocess derives the project subdirectory
 * under `<CLAUDE_CONFIG_DIR>/projects/`: NFC-normalize the absolute path
 * and replace `/` with `-`. Verified empirically against the entries in
 * `~/.claude/projects/` (e.g. `/Users/foo/Repos/bar` ↔
 * `-Users-foo-Repos-bar`). We compute this ourselves so the cleanup step
 * can target exactly the directory the subprocess wrote into.
 */
export function encodeProjectKey(absPath: string): string {
  return absPath.normalize('NFC').replace(/\//g, '-');
}

export function createSummaryQueryRunner(
  deps: SummaryQueryDeps = {},
): (opts: SummaryQueryOptions) => Promise<string> {
  const runPrompt: RunPromptFn = deps.runPrompt ?? runCliOnce;
  const tmpRoot = deps.tmpRoot ?? os.tmpdir();
  const resolveClaudeBinary = deps.resolveClaudeBinary ?? findSystemClaudeBinary;
  const scratchCwd = path.join(tmpRoot, SCRATCH_DIR_NAME);

  return async function runSummaryQuery(opts: SummaryQueryOptions): Promise<string> {
    const claudeBinary = resolveClaudeBinary();
    if (!claudeBinary) {
      throw new Error(
        'Claude binary not found: no system install and no SDK-bundled fallback. ' +
          'Configure a CLI path in Account Settings.',
      );
    }

    // mkdir -p is idempotent — the dir survives across calls so the
    // encoded projects path stays stable and we don't accumulate one
    // throwaway folder per summary in the user's session list.
    await fsPromises.mkdir(scratchCwd, { recursive: true });
    const projectsDir = path.join(
      opts.configDir,
      'projects',
      encodeProjectKey(scratchCwd),
    );

    try {
      return await runPrompt({
        claudeBinary,
        prompt: opts.prompt,
        model: opts.model,
        configDir: opts.configDir,
        cwd: scratchCwd,
      });
    } finally {
      // Sweep the JSONL the CLI wrote. Best-effort — the dir may not
      // exist on early failure, and we don't want cleanup errors to
      // mask the real outcome of the call. The scratch cwd itself is
      // intentionally left alone; reusing it across calls is the whole
      // point of this design.
      await fsPromises
        .rm(projectsDir, { recursive: true, force: true })
        .catch(() => {});
    }
  };
}
