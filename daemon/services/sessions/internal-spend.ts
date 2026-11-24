// OmniFex's own CLI runs — session summaries, Brain indexing, Brain curation —
// spend real money on the user's account, and leave a transcript the CLI wrote
// under `<configDir>/projects/<encoded-scratch>/`. The transcript is never
// kept: it is priced into the cost table and deleted, and the cost rows are the
// only record.
//
// History, because both earlier designs failed:
//  - The runner used to `rm -rf` the transcript as the call returned, racing
//    the cost watcher, so a non-deterministic fraction of the spend was priced.
//  - Then it moved transcripts into an archive under userData to be priced by
//    the hourly sweep and pruned later. Neither ever ran: the runner computed
//    the scratch dir from the unresolved /var tmpdir while the CLI writes under
//    /private/var, so from June to October 2026 every transcript stayed in the
//    real projects dir — 2,500 of them, listed as a project with no account.
//
// Pricing in the same step as deleting removes the race, the archive and its
// retention, and leaves nothing to sweep up later except strays from a crash.

import fs from 'node:fs';
import path from 'node:path';

/**
 * The scratch cwd every internal run uses, under `os.tmpdir()`. The CLI encodes
 * it into a real `projects/<encoded>/` directory, so OmniFex's own runs are
 * indistinguishable from user sessions by shape alone — only by this name.
 * One spelling, shared by every walker that must skip them.
 */
export const SCRATCH_DIR_NAME = 'omnifex-summary-scratch';

/**
 * A `projects/<encoded>/` directory that is really the scratch cwd. The CLI's
 * encoding replaces every non-alphanumeric character with `-`, so the name
 * survives as a substring — anything stricter would have to reconstruct the
 * per-machine tmpdir.
 */
export function isSummaryScratchProject(projectDirName: string): boolean {
  return projectDirName.includes(SCRATCH_DIR_NAME);
}

/** Every kind of internal run that costs money. A run that cannot say which
 *  one it is cannot be attributed, so callers must pass this. */
export const INTERNAL_KINDS = ['session-summarization', 'brain-index', 'brain-curation'] as const;
export type InternalKind = (typeof INTERNAL_KINDS)[number];

/**
 * Display label for a kind. This doubles as the row's `project_path`, so
 * `shortProject()` — which renders the last two segments — shows
 * "OmniFex/Brain index" in every existing table with no renderer change.
 *
 * The slash is load-bearing for that reason; don't "tidy" these into
 * single words.
 */
export const INTERNAL_LABEL: Record<InternalKind, string> = {
  'session-summarization': 'OmniFex/Session summarization',
  'brain-index': 'OmniFex/Brain index',
  'brain-curation': 'OmniFex/Brain curation',
};

/** `CostHistoryService.recordInternal`. Throws if the spend was not written. */
export type RecordInternalSpend = (p: {
  sessionId: string;
  content: string;
  kind: InternalKind;
  accountName: string;
  configDir: string;
}) => void;

/** Younger than this, a stray may belong to a run still in flight. */
const STRAY_MIN_AGE_MS = 10 * 60 * 1000;

/**
 * Which internal activity a run was, from its prompt. The Brain's preambles are
 * fixed strings in `brain/extract.ts` and `brain/curation.ts`; the summary
 * prompt is the one users can edit, so it is the fallback rather than a match.
 */
export function classifyInternalPrompt(prompt: string | null): InternalKind {
  if (!prompt) return 'session-summarization';
  if (prompt.startsWith('You are compressing')) return 'brain-curation';
  if (
    prompt.startsWith('You are extracting durable engineering knowledge') ||
    prompt.startsWith('You are turning one fact a developer explicitly captured')
  ) {
    return 'brain-index';
  }
  return 'session-summarization';
}

/**
 * The first user record's text. Whole lines, never a byte-capped head: a Brain
 * extraction prompt embeds the entire session it distils, so that one record
 * can run to megabytes, and a truncated line fails to parse and would be
 * misfiled as a summary.
 */
function firstPrompt(content: string): string | null {
  for (const line of content.split('\n')) {
    try {
      const rec = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
      if (rec.type === 'user' && typeof rec.message?.content === 'string') return rec.message.content;
    } catch {
      // Not JSON (a blank trailing line). Keep looking.
    }
  }
  return null;
}

export interface SettleOptions {
  /** `<configDir>/projects/<encoded-scratch>`. */
  projectsDir: string;
  accountName: string;
  configDir: string;
  record: RecordInternalSpend;
  /** Known to the runner. Omitted, each transcript is classified by its prompt. */
  kind?: InternalKind;
  /** Skip transcripts modified within `minAgeMs` of `nowMs`. */
  nowMs?: number;
  minAgeMs?: number;
}

/**
 * Price every transcript in a scratch projects dir, delete each one whose spend
 * was recorded, and remove the dir once nothing is left in it.
 *
 * A transcript whose spend could not be recorded is KEPT — it is the only
 * record of a paid call — and so is its dir, for the next sweep to retry.
 */
export function settleTranscripts(opts: SettleOptions): { settled: number; failed: number } {
  let names: string[];
  try {
    names = fs.readdirSync(opts.projectsDir);
  } catch {
    // The ordinary state when the CLI failed before writing anything.
    return { settled: 0, failed: 0 };
  }

  let settled = 0;
  let failed = 0;
  let left = 0;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(opts.projectsDir, name);
    try {
      if (opts.nowMs !== undefined && opts.nowMs - fs.statSync(file).mtimeMs < (opts.minAgeMs ?? 0)) {
        left += 1;
        continue;
      }
      const content = fs.readFileSync(file, 'utf8');
      opts.record({
        sessionId: name.slice(0, -'.jsonl'.length),
        content,
        kind: opts.kind ?? classifyInternalPrompt(firstPrompt(content)),
        accountName: opts.accountName,
        configDir: opts.configDir,
      });
      fs.unlinkSync(file);
      settled += 1;
    } catch {
      left += 1;
      failed += 1;
    }
  }

  // Nothing billable left: the rest is the CLI's per-cwd auto-memory and the
  // like, which only exists because the scratch dir did.
  if (left === 0) fs.rmSync(opts.projectsDir, { recursive: true, force: true });
  return { settled, failed };
}

/**
 * The hourly backstop: settle every scratch transcript the runner did not — a
 * crash mid-call, or an older build still running. Transcripts younger than
 * ten minutes are left to the run that is still writing them.
 */
export function settleStrandedScratch(opts: {
  accounts: { name: string; config_dir: string }[];
  record: RecordInternalSpend;
  nowMs: number;
}): { settled: number; failed: number } {
  let settled = 0;
  let failed = 0;
  for (const account of opts.accounts) {
    const projectsDir = path.join(account.config_dir, 'projects');
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory() || !isSummaryScratchProject(dir.name)) continue;
      const r = settleTranscripts({
        projectsDir: path.join(projectsDir, dir.name),
        accountName: account.name,
        configDir: account.config_dir,
        record: opts.record,
        nowMs: opts.nowMs,
        minAgeMs: STRAY_MIN_AGE_MS,
      });
      settled += r.settled;
      failed += r.failed;
    }
  }
  return { settled, failed };
}
