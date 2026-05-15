import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  query,
  type Options,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { findSystemClaudeBinary } from './factory';
import { buildClaudeEnv } from '../util/claude-env';

// ---------------------------------------------------------------------------
// One-shot summary runner
//
// Background:
//   The Claude Code subprocess always persists a JSONL under
//     <CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<uuid>.jsonl
//   regardless of which SDK API surface you use. Earlier the summary path
//   called V1 `query()` with the real project path as `cwd`, leaving
//   throwaway one-message sessions in the user's real project session list.
//
//   The summary path uses the streaming `query()` API wrapped in
//   `runQueryOnce` (below) for one-shot await-and-go ergonomics, with
//   the following guard rails:
//     - Pins every call to a single STABLE scratch cwd
//       `<os.tmpdir()>/omnifex-summary-scratch`. The encoded form is the
//       same on every call, so we don't accumulate one
//       `<configDir>/projects/-var-folders-...-omnifex-summary-XXXXX/`
//       folder per call. After each call we wipe the contents of the
//       encoded projects dir.
//     - `settingSources: []` keeps CLAUDE.md and project settings out
//       of the summary prompt (set explicitly for defensiveness).
//     - `permissionMode: 'bypassPermissions'` +
//       `allowDangerouslySkipPermissions: true` + `disallowedTools: ['*']`
//       — summarization writes nothing and reads nothing; it just gets
//       a model response back as a string.
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
  /** SDK model id, e.g. 'claude-haiku-4-5'. */
  model: string;
  /** The resolved account's CLAUDE_CONFIG_DIR — auth lives here. */
  configDir: string;
}

/** Subset of the SDK call surface we depend on — exposed for testing. */
export type RunPromptFn = (
  message: string,
  options: Options,
) => Promise<SDKResultMessage>;

/**
 * One-shot wrapper around the SDK's streaming `query()` API. Iterates
 * until the first `result` message and returns it; closes the underlying
 * `Query` handle on every exit path (success, no-result stream end,
 * iteration error). `query.close()` errors are swallowed so they cannot
 * mask either the result or the original iteration error.
 *
 * The first parameter is the SDK's `query` function, taken as a
 * dependency so unit tests can drive it without mocking the module.
 */
export async function runQueryOnce(
  queryFn: typeof query,
  message: string,
  options: Options,
): Promise<SDKResultMessage> {
  const q = queryFn({ prompt: message, options });
  try {
    for await (const msg of q as AsyncIterable<unknown>) {
      if ((msg as { type?: string } | null)?.type === 'result') {
        return msg as SDKResultMessage;
      }
    }
    throw new Error('SDK query ended without a result message');
  } finally {
    try {
      q.close();
    } catch {
      // best-effort — never let close() mask the real outcome
    }
  }
}

export interface SummaryQueryDeps {
  /**
   * Defaults to a `runQueryOnce(query, …)` wrapper around the SDK's
   * streaming `query()`. Injected in tests.
   */
  runPrompt?: RunPromptFn;
  /** Defaults to `os.tmpdir()`. Injected in tests. */
  tmpRoot?: string;
  /**
   * Resolve the Claude Code binary to spawn. Defaults to the same probe
   * the V1 sessions/factory path uses (`findSystemClaudeBinary` →
   * system installs → SDK-bundled per-platform binary). Injected in tests.
   *
   * Setting this explicitly is important: the V2 SDK's auto-resolution
   * (`require.resolve` from the SDK's own module URL) works in plain Node
   * but fails inside Electron's bundled main process — the spawn fails
   * with `[ENOTDIR] spawn ENOTDIR`. Passing `pathToClaudeCodeExecutable`
   * explicitly bypasses that resolver, the same way the interactive
   * sessions path has always done.
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
  const runPrompt: RunPromptFn =
    deps.runPrompt ?? ((message, options) => runQueryOnce(query, message, options));
  const tmpRoot = deps.tmpRoot ?? os.tmpdir();
  const resolveClaudeBinary = deps.resolveClaudeBinary ?? findSystemClaudeBinary;
  const scratchCwd = path.join(tmpRoot, SCRATCH_DIR_NAME);

  return async function runSummaryQuery(opts: SummaryQueryOptions): Promise<string> {
    // Resolve the binary up front for the same reason the interactive
    // session path does — the SDK's auto-resolver fails inside Electron's
    // bundled main process (spawn ENOTDIR). Fail fast with a clear error
    // when no binary can be found, so the renderer surfaces something
    // diagnosable instead of an opaque spawn error.
    const claudeBinary = resolveClaudeBinary();
    if (!claudeBinary) {
      throw new Error(
        'Claude binary not found: no system install and no SDK-bundled fallback. ' +
          'Configure a CLI path in Account Settings or reinstall @anthropic-ai/claude-agent-sdk.',
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
      const result = await runPrompt(opts.prompt, {
        model: opts.model,
        cwd: scratchCwd,
        // Routed through buildClaudeEnv — empty / ~/.claude-resolving
        // configDir throws here so a stale opts.configDir can't trigger
        // a JSONL leak into the user's default Claude state.
        env: buildClaudeEnv(opts.configDir),
        pathToClaudeCodeExecutable: claudeBinary,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        disallowedTools: ['*'],
        settingSources: [],
      });
      if (result.subtype === 'success') return result.result;
      return '';
    } finally {
      // Sweep the JSONL the subprocess wrote. Best-effort — the dir may
      // not exist on early failure, and we don't want cleanup errors to
      // mask the real outcome of the call. The scratch cwd itself is
      // intentionally left alone; reusing it across calls is the whole
      // point of this design.
      await fsPromises
        .rm(projectsDir, { recursive: true, force: true })
        .catch(() => {});
    }
  };
}
