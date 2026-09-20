/**
 * The Bash tool's STRUCTURED result — the half the model never sees.
 *
 * A Bash tool_result carries two payloads. The `tool_result` content block is
 * the text the model reads (stdout/stderr), and that is all `BashWidget` used
 * to render. Alongside it the CLI attaches a structured object the model is
 * explicitly not shown, described in its own schema as "client-facing — lets
 * clients render git activity without re-parsing stdout".
 *
 * Two fields there are worth rendering:
 *
 *  - `gitOperation` — a classification of the git/gh work the command did
 *    (push / commit / branch / pr). Already flowing today, no flag needed.
 *  - `bashEditDiff` — a per-file diff of what the command changed. Added in
 *    CLI 2.1.269 and only populated in `auto` / `bypassPermissions` sessions.
 *
 * THE SPELLING TRAP: the same payload is keyed `tool_use_result` in the live
 * stream-json stdout and `toolUseResult` in the on-disk JSONL. Verified against
 * CLI 2.1.270. OmniFex reads both the stream and the file, so reading only one
 * spelling yields a feature that works on exactly one path. `src/lib/taskList.ts`
 * hit this first and handles both; so does this.
 */

/** One tool-result-bearing node as the renderer holds it. */
interface StreamNodeLike {
  kind: string;
  raw: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Map every tool_use_id to the structured result attached to its envelope.
 *
 * An envelope carries at most ONE structured result but may carry several
 * `tool_result` blocks (parallel tool calls). There is no field tying the
 * payload to a particular block, so an envelope with more than one block is
 * skipped entirely rather than attributing one command's diff to another
 * command's row. No such envelope appears in 874 sampled transcripts — this
 * guard is for being correct rather than lucky.
 */
export function collectStructuredResults(
  nodes: readonly StreamNodeLike[],
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();

  for (const node of nodes) {
    if (node?.kind !== 'user') continue;
    const raw = asRecord(node.raw);
    if (!raw) continue;

    // Live stream first: chat mode is the path where a missing payload would
    // otherwise be invisible until the transcript is reloaded from disk.
    const structured = asRecord(raw.tool_use_result) ?? asRecord(raw.toolUseResult);
    if (!structured) continue;

    const message = asRecord(raw.message);
    const content = message?.content;
    if (!Array.isArray(content)) continue;

    const ids: string[] = [];
    for (const block of content) {
      const b = asRecord(block);
      if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') ids.push(b.tool_use_id);
    }
    if (ids.length !== 1) continue;

    out.set(ids[0], structured);
  }

  return out;
}

export interface GitOperationSummary {
  kind: 'push' | 'commit' | 'branch' | 'pr';
  /** Past-tense verb for the chip. */
  label: string;
  /** Branch, sha, ref or PR number. */
  detail: string;
}

/**
 * The git/gh operation a Bash command performed, if any.
 *
 * Shapes observed across 323 real occurrences on disk: `push {branch}`,
 * `commit {sha, kind}`, `branch {ref, action}`, `pr {number, action}`. The
 * `branch` and `pr` forms carry their own verb in `action`; push and commit do
 * not, so those get a fixed label.
 */
export function parseGitOperation(
  structured: Record<string, unknown> | undefined | null,
): GitOperationSummary | null {
  const op = asRecord(structured?.gitOperation);
  if (!op) return null;

  const push = asRecord(op.push);
  if (push && typeof push.branch === 'string') {
    return { kind: 'push', label: 'pushed', detail: push.branch };
  }

  const commit = asRecord(op.commit);
  if (commit && typeof commit.sha === 'string') {
    return { kind: 'commit', label: 'committed', detail: commit.sha };
  }

  const branch = asRecord(op.branch);
  if (branch && typeof branch.ref === 'string') {
    const action = typeof branch.action === 'string' ? branch.action : 'changed';
    return { kind: 'branch', label: action, detail: branch.ref };
  }

  const pr = asRecord(op.pr);
  if (pr && typeof pr.number === 'number') {
    const action = typeof pr.action === 'string' ? pr.action : 'updated';
    return { kind: 'pr', label: action, detail: `#${String(pr.number)}` };
  }

  return null;
}

export interface BashEditDiffFile {
  filePath: string;
  added: number;
  removed: number;
  created: boolean;
  deleted: boolean;
}

export interface BashEditDiffSummary {
  files: BashEditDiffFile[];
  /** Files changed beyond the ones detailed in `files`. */
  moreFiles: number;
  /** Absolute paths of every changed file known, shown or not (max 200). */
  changedFiles: string[];
  /** Part of the diff could not be computed. */
  unavailable: boolean;
  /** Another command ran in this repo concurrently — attribution is unreliable. */
  shared: boolean;
}

/**
 * A rendering-ready summary of what a Bash command changed on disk.
 *
 * Deliberately a summary, not a diff viewer: the CLI itself labels this "a
 * convenience view, not a review or audit of the command", and rendering it as
 * an authoritative diff would oversell it.
 *
 * Returns null when there is nothing worth a panel — a `skipped` diff, or an
 * empty one with no overflow and no caveat to report.
 */
export function parseBashEditDiff(
  structured: Record<string, unknown> | undefined | null,
): BashEditDiffSummary | null {
  const diff = asRecord(structured?.bashEditDiff);
  if (!diff || diff.skipped === true) return null;

  const files: BashEditDiffFile[] = [];
  if (Array.isArray(diff.files)) {
    for (const entry of diff.files) {
      const f = asRecord(entry);
      if (!f || typeof f.filePath !== 'string') continue;
      let added = 0;
      let removed = 0;
      if (Array.isArray(f.hunks)) {
        for (const h of f.hunks) {
          const lines = asRecord(h)?.lines;
          if (!Array.isArray(lines)) continue;
          for (const line of lines) {
            if (typeof line !== 'string') continue;
            if (line.startsWith('+')) added++;
            else if (line.startsWith('-')) removed++;
          }
        }
      }
      files.push({
        filePath: f.filePath,
        added,
        removed,
        created: f.created === true,
        deleted: f.deleted === true,
      });
    }
  }

  const moreFiles = typeof diff.moreFiles === 'number' ? diff.moreFiles : 0;
  const changedFiles = Array.isArray(diff.changedFiles)
    ? diff.changedFiles.filter((p): p is string => typeof p === 'string')
    : [];
  const unavailable = diff.unavailable === true;
  const shared = diff.shared === true;

  if (files.length === 0 && moreFiles === 0 && !unavailable && !shared) return null;

  return { files, moreFiles, changedFiles, unavailable, shared };
}
