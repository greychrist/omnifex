import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  unstable_v2_prompt,
  type SDKResultMessage,
  type SDKSessionOptions,
} from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// One-shot summary runner
//
// Background:
//   The Claude Code subprocess always persists a JSONL under
//     <CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<uuid>.jsonl
//   regardless of which SDK API surface you use — `unstable_v2_prompt`
//   doesn't change that, it just hides the session lifecycle from the
//   consumer. Earlier the summary path called V1 `query()` with the real
//   project path as `cwd`, leaving throwaway one-message sessions in the
//   user's real project session list.
//
//   This wrapper:
//     1. Switches to V2's `unstable_v2_prompt` (single await, no streaming
//        loop on the consumer side).
//     2. Pins every call to a single STABLE scratch cwd —
//        `<os.tmpdir()>/omnifex-summary-scratch`. The encoded form is the
//        same on every call, so we don't accumulate one
//        `<configDir>/projects/-var-folders-...-omnifex-summary-XXXXX/`
//        folder per call. After each call we wipe the contents of the
//        encoded projects dir.
//     3. The V2 default of `settingSources: []` keeps CLAUDE.md and
//        project settings out of the summary prompt (set explicitly for
//        defensiveness).
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
  options: SDKSessionOptions,
) => Promise<SDKResultMessage>;

export interface SummaryQueryDeps {
  /** Defaults to the SDK's `unstable_v2_prompt`. Injected in tests. */
  runPrompt?: RunPromptFn;
  /** Defaults to `os.tmpdir()`. Injected in tests. */
  tmpRoot?: string;
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
  const runPrompt: RunPromptFn = deps.runPrompt ?? unstable_v2_prompt;
  const tmpRoot = deps.tmpRoot ?? os.tmpdir();
  const scratchCwd = path.join(tmpRoot, SCRATCH_DIR_NAME);

  return async function runSummaryQuery(opts: SummaryQueryOptions): Promise<string> {
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
        env: { ...process.env, CLAUDE_CONFIG_DIR: opts.configDir },
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
