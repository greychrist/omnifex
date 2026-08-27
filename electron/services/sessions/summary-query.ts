import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { findSystemClaudeBinary } from './binary';
import { buildClaudeEnv } from '../util/claude-env';
import { encodeProjectId } from '../project-paths';
import {
  archiveDirFor,
  archiveTranscripts,
  type InternalKind,
} from './internal-archive';

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

/**
 * Exported because the Brain's session source has to EXCLUDE these. The CLI
 * encodes this scratch cwd into a real `projects/<encoded>/` directory, so
 * OmniFex's own summary runs are indistinguishable from user sessions by shape
 * alone — only by name. Two independent spellings of that name would
 * eventually diverge and quietly start indexing them.
 */
export const SCRATCH_DIR_NAME = 'omnifex-summary-scratch';

/**
 * Account segment used when `resolveAccountName` comes back empty. Visible on
 * purpose: an unattributed transcript is a problem to notice, and keeping it
 * beats deleting it.
 */
export const UNRESOLVED_ACCOUNT = '_unresolved';

export interface SummaryQueryOptions {
  prompt: string;
  /** CLI model id, e.g. 'claude-haiku-4-5'. */
  model: string;
  /** The resolved account's CLAUDE_CONFIG_DIR — auth lives here. */
  configDir: string;
  /**
   * Which internal activity is paying for this call. Required: a run that
   * cannot say what it paid for cannot be attributed in the Cost Report, and
   * an unattributed line item is indistinguishable from a bug.
   */
  kind: InternalKind;
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

/**
 * One `claude -p` call: the reply, and what it cost.
 *
 * The cost figures are the CLI's OWN accounting, lifted from the
 * `--output-format json` envelope this runner already receives — not an
 * estimate derived from a local pricing table that would silently drift from
 * Anthropic's. Every field is nullable because the envelope is the CLI's, not
 * ours: a future version that stops emitting one must degrade to "unknown"
 * rather than to a confident zero, which would read as "this was free".
 */
export interface CliRunResult {
  /** The model's reply text — what every caller before this wanted. */
  result: string;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  durationMs: number | null;
}

/** Subset of the CLI runner surface we depend on — exposed for testing. */
export type RunPromptFn = (params: RunPromptParams) => Promise<CliRunResult>;

/**
 * Spawn `claude -p <prompt> --output-format json` and resolve with the
 * `result` field of the CLI's JSON reply. Rejects on non-zero exit with
 * a message that includes captured stderr. Exposed as a default
 * implementation of `RunPromptFn` for the runner factory.
 */
/**
 * The fields of the CLI's `--output-format json` envelope we read. Verified
 * against 2.1.229; anything absent degrades to null rather than to zero.
 */
interface CliResultEnvelope {
  result?: unknown;
  total_cost_usd?: unknown;
  duration_ms?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
}

/** A finite number, or null. Guards against a string or a missing field. */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export async function runCliOnce(p: RunPromptParams): Promise<CliRunResult> {
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

  return await new Promise<CliRunResult>((resolve, reject) => {
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
        const parsed = JSON.parse(stdout) as CliResultEnvelope;
        resolve({
          result: typeof parsed?.result === 'string' ? parsed.result.trim() : '',
          costUsd: num(parsed?.total_cost_usd),
          inputTokens: num(parsed?.usage?.input_tokens),
          outputTokens: num(parsed?.usage?.output_tokens),
          cacheReadTokens: num(parsed?.usage?.cache_read_input_tokens),
          cacheCreationTokens: num(parsed?.usage?.cache_creation_input_tokens),
          durationMs: num(parsed?.duration_ms),
        });
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
   * `internalArchiveRoot(app.getPath('userData'))`. REQUIRED — there is no
   * default, because a default would let a caller silently fall back to
   * discarding transcripts, which is the exact bug this replaces.
   */
  archiveRoot: string;
  /**
   * Account that owns `configDir`. Ownership comes from the config dir the
   * run was launched with, never from `resolve()` — the same rule the Brain
   * uses for its sources.
   */
  resolveAccountName: (configDir: string) => string | null;
  /** Injected in tests so the date partition is deterministic. */
  now?: () => Date;
  /**
   * Resolve the Claude Code binary. Defaults to `findSystemClaudeBinary`
   * (system installs → app-bundled per-platform binary). Injected in
   * tests so they can pin to a fake path without depending on disk state.
   */
  resolveClaudeBinary?: () => string | null;
}


export function createSummaryQueryRunner(
  deps: SummaryQueryDeps,
): (opts: SummaryQueryOptions) => Promise<CliRunResult> {
  const runPrompt: RunPromptFn = deps.runPrompt ?? runCliOnce;
  const tmpRoot = deps.tmpRoot ?? os.tmpdir();
  const resolveClaudeBinary = deps.resolveClaudeBinary ?? findSystemClaudeBinary;
  const { archiveRoot, resolveAccountName } = deps;
  const scratchCwd = path.join(tmpRoot, SCRATCH_DIR_NAME);

  return async function runSummaryQuery(opts: SummaryQueryOptions): Promise<CliRunResult> {
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
      encodeProjectId(scratchCwd),
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
      // Move the JSONL the CLI wrote into the archive, then clear what is
      // left behind. This used to be an unconditional `rm -rf`, which raced
      // the cost watcher and destroyed the only local record that a paid call
      // happened — see the spec for the reconciliation that cost us.
      //
      // Best-effort as a whole: the directory may not exist if the CLI failed
      // before writing, and a cleanup error must never mask the real outcome
      // of the call. The scratch cwd itself is still left alone; reusing it
      // across calls is the whole point of pinning it.
      try {
        const accountName = resolveAccountName(opts.configDir) ?? UNRESOLVED_ACCOUNT;
        const destDir = archiveDirFor(
          archiveRoot,
          accountName,
          opts.kind,
          (deps.now?.() ?? new Date()).toISOString().slice(0, 10),
        );
        await archiveTranscripts({ fs: fsPromises, projectsDir, destDir });
      } catch {
        // Archiving failed. The transcript stays where the CLI wrote it
        // rather than being deleted, so nothing is lost; the next run's
        // sweep will find it.
      }
      // Only removes what is still there — anything archived is already gone.
      await fsPromises
        .rm(projectsDir, { recursive: true, force: true })
        .catch(() => {});
    }
  };
}
