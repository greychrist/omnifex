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

// Overlapping calls share the projects dir; harmless, since pricing is by session id and the CLI's open fd survives the unlink.

// Visible on purpose: unattributed spend should be noticed, not dropped.
export const UNRESOLVED_ACCOUNT = '_unresolved';

export interface SummaryQueryOptions {
  prompt: string;
  model: string;
  configDir: string;
  kind: InternalKind;
}

export interface RunPromptParams {
  claudeBinary: string;
  prompt: string;
  model?: string;
  configDir: string;
  cwd: string;
}

// Every field nullable: a missing envelope field must read as unknown, never a confident zero.
export interface CliRunResult {
  result: string;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  durationMs: number | null;
  model: string | null;
}

export type RunPromptFn = (params: RunPromptParams) => Promise<CliRunResult>;

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

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Stopped at close: a run left behind paid for its whole call, and the next start re-queued and paid again.
const inFlightRuns = new Set<ChildProcessByStdio<null, Readable, Readable>>();

export function stopInternalRuns(): number {
  const n = inFlightRuns.size;
  for (const child of inFlightRuns) child.kill('SIGTERM');
  inFlightRuns.clear();
  return n;
}

export async function runCliOnce(p: RunPromptParams): Promise<CliRunResult> {
  // argv cannot carry a NUL, and a transcript can.
  const args: string[] = ['-p', p.prompt.replaceAll('\0', ''), '--output-format', 'json'];
  if (p.model) args.push('--model', p.model);
  args.push('--permission-mode', 'bypassPermissions');
  args.push('--disallowed-tools', '*');
  // `--strict-mcp-config` is load-bearing: `--mcp-config` merges with the account's config, so only strict mode makes the empty set
  // authoritative. Loading MCP schemas cost ~2 s and ~7.6k tokens per call.
  args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');

  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    p.claudeBinary,
    args,
    {
      cwd: p.cwd,
      env: buildClaudeEnv(p.configDir),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  inFlightRuns.add(child);
  child.once('exit', () => inFlightRuns.delete(child));
  child.once('error', () => inFlightRuns.delete(child));

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
  runPrompt?: RunPromptFn;
  tmpRoot?: string;
  // No default: one would let a caller delete transcripts without recording their cost.
  recordSpend: RecordInternalSpend;
  // From the run's config dir, never from `resolve()`.
  resolveAccountName: (configDir: string) => string | null;
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

    await fsPromises.mkdir(scratchCwd, { recursive: true });
    // Encode the realpath: the CLI names its projects dir after it, and macOS's tmpdir is a /var symlink.
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
      // A cleanup failure must never mask the call's outcome; a transcript whose spend was not recorded is left for the sweep.
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
