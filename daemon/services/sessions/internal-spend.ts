// Price each transcript in the same step as deleting it: deleting first raced the cost watcher and lost spend.

import fs from 'node:fs';
import path from 'node:path';

// Only this name tells OmniFex's own runs from user sessions; every walker that must skip them shares it.
export const SCRATCH_DIR_NAME = 'omnifex-summary-scratch';

// Substring match: the CLI maps non-alphanumerics to `-`, and the tmpdir prefix is per-machine.
export function isSummaryScratchProject(projectDirName: string): boolean {
  return projectDirName.includes(SCRATCH_DIR_NAME);
}

export const INTERNAL_KINDS = ['session-summarization', 'brain-index', 'brain-curation'] as const;
export type InternalKind = (typeof INTERNAL_KINDS)[number];

// The slash is load-bearing: this is the row's `project_path`, and `shortProject()` shows its last two segments.
export const INTERNAL_LABEL: Record<InternalKind, string> = {
  'session-summarization': 'OmniFex/Session summarization',
  'brain-index': 'OmniFex/Brain index',
  'brain-curation': 'OmniFex/Brain curation',
};

// Throws if the spend was not written.
export type RecordInternalSpend = (p: {
  sessionId: string;
  content: string;
  kind: InternalKind;
  accountName: string;
  configDir: string;
}) => void;

// A younger stray may belong to a run still in flight.
const STRAY_MIN_AGE_MS = 10 * 60 * 1000;

// The summary prompt is user-editable, so it is the fallback rather than a match.
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

// Whole lines, never a byte-capped head: a Brain extraction prompt can run to megabytes, and a truncated line would be misfiled.
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
  projectsDir: string;
  accountName: string;
  configDir: string;
  record: RecordInternalSpend;
  kind?: InternalKind;
  nowMs?: number;
  minAgeMs?: number;
}

// A transcript whose spend could not be recorded is kept: it is the only record of a paid call.
export function settleTranscripts(opts: SettleOptions): { settled: number; failed: number } {
  let names: string[];
  try {
    names = fs.readdirSync(opts.projectsDir);
  } catch {
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

  if (left === 0) fs.rmSync(opts.projectsDir, { recursive: true, force: true });
  return { settled, failed };
}

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
