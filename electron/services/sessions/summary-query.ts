import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { findSystemClaudeBinary } from './binary';
import { buildClaudeEnv } from '../util/claude-env';
import { encodeProjectId } from '../project-paths';
import {
  SCRATCH_DIR_NAME,
  settleTranscripts,
  type InternalKind,
  type RecordInternalSpend,
} from './internal-spend';

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
//       folder per call. After each call the JSONL's spend is recorded
//       and the JSONL deleted, then the encoded projects dir (named after
//       the cwd's realpath, as the CLI names it) is removed. See
//       internal-spend.ts.
//     - `--permission-mode bypassPermissions` skips approval prompts —
//       summarization runs as a one-shot, no human in the loop.
//     - `--disallowed-tools '*'` blocks every tool — the summary prompt
//       has no need to read or write.
//     - `--strict-mcp-config` with an empty `--mcp-config` starts no MCP
//       servers at all. A call that may use no tools has no use for their
//       schemas either, and loading them cost seconds and tokens per call.
//
//   Concurrency note: if two calls overlap they share the projects dir,
//   so one call's settle may price and delete the other's transcript. That
//   is harmless: pricing is by session id, so the spend is recorded once
//   whichever call gets there, and the CLI's open fd survives the unlink.
// ---------------------------------------------------------------------------

/**
 * Account name recorded when `resolveAccountName` comes back empty. Visible on
 * purpose: unattributed spend is a problem to notice, and recording it beats
 * dropping it.
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
  /**
   * The model that ran, from the envelope's `modelUsage` — the key that took
   * the most money when the CLI used a helper model too. Callers may pass an
   * alias (`sonnet`); this is what it resolved to. Null when not reported.
   */
  model: string | null;
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
  modelUsage?: unknown;
}

/** The `modelUsage` key with the largest `costUSD`, or null. */
function billedModel(modelUsage: unknown): string | null {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  let best: string | null = null;
  let bestCost = -1;
  for (const [model, v] of Object.entries(modelUsage as Record<string, { costUSD?: unknown }>)) {
    const cost = num(v?.costUSD) ?? 0;
    if (cost > bestCost) {
      best = model;
      bestCost = cost;
    }
  }
  return best;
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
  // No MCP servers. Measured against the personal config dir with a four-token
  // reply: 5.4s wall / 11,456 cache-creation tokens / $0.047 with the account's
  // servers loaded, 3.5s / 3,878 / $0.017 without — ~1.9s and ~7.6k prompt
  // tokens of tool schemas on EVERY call, for tools `--disallowed-tools '*'`
  // has already forbidden. On Brain extraction that is a fixed tax per item,
  // paid the same whether the item is a 2MB transcript or one line.
  //
  // `--strict-mcp-config` is the load-bearing half: `--mcp-config` MERGES with
  // the account's own configuration rather than replacing it, which is what
  // brain/mcp-registration.ts depends on when it adds the Brain's server to a
  // real session. Only strict mode makes an empty set authoritative.
  args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');

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
          model: billedModel(parsed?.modelUsage),
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
   * `costHistory.recordInternal`. REQUIRED — there is no default, because a
   * default would let a caller delete transcripts without recording what
   * they cost.
   */
  recordSpend: RecordInternalSpend;
  /**
   * Account that owns `configDir`. Ownership comes from the config dir the
   * run was launched with, never from `resolve()` — the same rule the Brain
   * uses for its sources.
   */
  resolveAccountName: (configDir: string) => string | null;
  /**
   * Resolve the Claude Code binary. main and the daemon wire this to
   * `ClaudeBinaryService.findBestBinary()` so the binary picked in Settings
   * wins; unset, it falls back to plain discovery (`findSystemClaudeBinary`).
   */
  resolveClaudeBinary?: () => string | null;
}


export function createSummaryQueryRunner(
  deps: SummaryQueryDeps,
): (opts: SummaryQueryOptions) => Promise<CliRunResult> {
  const runPrompt: RunPromptFn = deps.runPrompt ?? runCliOnce;
  const tmpRoot = deps.tmpRoot ?? os.tmpdir();
  const resolveClaudeBinary = deps.resolveClaudeBinary ?? findSystemClaudeBinary;
  const { recordSpend, resolveAccountName } = deps;
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
    // The CLI names its projects dir after the REALPATH of its cwd. macOS's
    // os.tmpdir() is /var/folders/..., a symlink to /private/var/folders/...;
    // encoding the unresolved path pointed the cleanup below at a
    // directory that never existed, so from June to October every transcript
    // stayed in the real projects dir and surfaced as a project.
    const projectsDir = path.join(
      opts.configDir,
      'projects',
      encodeProjectId(await fsPromises.realpath(scratchCwd)),
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
      // Record what the call cost, then delete the transcript — it is never
      // kept. A cleanup failure must never mask the real outcome of the call,
      // and a transcript whose spend could not be recorded is left for the
      // hourly sweep (settleStrandedScratch) rather than deleted. The scratch
      // cwd itself stays; reusing it across calls is the whole point.
      try {
        settleTranscripts({
          projectsDir,
          kind: opts.kind,
          accountName: resolveAccountName(opts.configDir) ?? UNRESOLVED_ACCOUNT,
          configDir: opts.configDir,
          record: recordSpend,
        });
      } catch {
        // See above.
      }
    }
  };
}
