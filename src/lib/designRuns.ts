/**
 * Claude Design runs in the Modern work timeline.
 *
 * A design takes a dozen calls — read the guide, list the types, create from
 * one, write the canvas files into the scratchpad, publish — and drawn one
 * step each they bury the one thing worth seeing, the page. A run of them
 * folds into a single Design step that opens onto those calls and links to
 * the published page. Pure, so the folding is tested without rendering.
 */
import type { WorkEntry } from './modernGrouping';
import { isArtifactTool, type StepState } from './modernSteps';

export { isArtifactTool };

type ToolEntry = Extract<WorkEntry, { type: 'tool' }>;

export interface DesignRun {
  type: 'design';
  key: string;
  entries: WorkEntry[];
}

export type TimelineEntry = WorkEntry | DesignRun;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** A ToolSearch that loads Claude Design's tools — the run's first move. */
function loadsArtifactTools(e: WorkEntry): boolean {
  return e.type === 'tool' && e.name === 'ToolSearch' && /claude-artifacts|\bArtifact/.test(str(e.input.query));
}

/** File work in the session's scratchpad, where a design's files are written
 *  before they are published. */
function touchesScratchpad(e: ToolEntry): boolean {
  if (!['Write', 'Edit', 'MultiEdit', 'Read', 'Bash'].includes(e.name)) return false;
  return /\/scratchpad\//.test(str(e.input.file_path) || str(e.input.command));
}

/** Progress and todo bookkeeping: says how far along the work is, never
 *  what it is, so it neither starts nor ends a run. */
function isBookkeeping(e: ToolEntry): boolean {
  return e.name === 'mcp__omnifex__progress' || e.name === 'TodoWrite' || /^Task[A-Z]/.test(e.name);
}

/** What may sit between two design calls and still belong to the run. */
function belongsInside(e: WorkEntry): boolean {
  if (e.type === 'thinking') return true;
  return isArtifactTool(e.name) || loadsArtifactTools(e) || touchesScratchpad(e) || isBookkeeping(e);
}

/** What just before a run's first design call is the run's own set-up: the
 *  tool loading, and the files it is about to publish. */
function opensRun(e: TimelineEntry): boolean {
  return e.type === 'tool' && (loadsArtifactTools(e) || touchesScratchpad(e));
}

const isDesignCall = (e: WorkEntry): e is ToolEntry => e.type === 'tool' && isArtifactTool(e.name);

/**
 * Folds each run of Claude Design calls into one DesignRun. A run spans its
 * first design call to its last, taking the thoughts, tool loading,
 * scratchpad file work and bookkeeping between them, plus the tool loading
 * and scratchpad files just before it.
 * Anything else ends the run, and thoughts after its last call stay outside.
 */
export function foldDesignRuns(entries: WorkEntry[]): TimelineEntry[] {
  if (!entries.some(isDesignCall)) return entries;
  const out: TimelineEntry[] = [];
  let i = 0;
  while (i < entries.length) {
    if (!isDesignCall(entries[i])) {
      out.push(entries[i]);
      i += 1;
      continue;
    }
    // Take back the set-up that opened the run, reaching past bookkeeping
    // but not starting on it.
    const lead: WorkEntry[] = [];
    while (out.length > 0) {
      const prev = out[out.length - 1];
      if (prev.type === 'design' || !(opensRun(prev) || (prev.type === 'tool' && isBookkeeping(prev)))) break;
      lead.unshift(prev);
      out.pop();
    }
    while (lead.length > 0 && !opensRun(lead[0])) {
      out.push(lead.shift() as WorkEntry);
    }
    let last = i;
    let j = i + 1;
    while (j < entries.length && belongsInside(entries[j])) {
      if (isDesignCall(entries[j])) last = j;
      j += 1;
    }
    const run = [...lead, ...entries.slice(i, last + 1)];
    out.push({ type: 'design', key: `design-${run[0].key}`, entries: run });
    i = last + 1;
  }
  return out;
}

export interface DesignRunSummary {
  /** What was made, by its title; null until something names it. */
  title: string | null;
  /** The published page; null until a publish answers with one. */
  url: string | null;
  state: StepState;
}

/** Calls whose answer is the artifact itself — a listing of types carries
 *  links too, to the types' own pages, which are not this design. */
const OWN_ANSWER = /(?:^|__)(?:publish_files|publish_version|edit_version|create_from_type)$|^Artifact$/;

function field(text: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(text);
  return m ? m[1] : null;
}

/** The run's title, its page, and whether it is going, done or failed. */
export function designRunSummary(entries: WorkEntry[]): DesignRunSummary {
  const calls = entries.filter(isDesignCall);
  let title: string | null = null;
  let url: string | null = null;
  for (const c of calls) {
    title = str(c.input.title) || title;
    if (c.status === 'done' && OWN_ANSWER.test(c.name) && c.resultText) {
      const u = field(c.resultText, 'url');
      if (u?.startsWith('https://')) url = u;
      title = field(c.resultText, 'title') ?? title;
    }
  }
  const lastCall = calls[calls.length - 1];
  const state: StepState = entries.some((e) => e.type === 'tool' && e.status === 'pending')
    ? 'running'
    : lastCall?.status === 'error' ? 'error' : 'done';
  return { title, url, state };
}
