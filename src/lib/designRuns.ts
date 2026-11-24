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

function loadsArtifactTools(e: WorkEntry): boolean {
  return e.type === 'tool' && e.name === 'ToolSearch' && /claude-artifacts|\bArtifact/.test(str(e.input.query));
}

function touchesScratchpad(e: ToolEntry): boolean {
  if (!['Write', 'Edit', 'MultiEdit', 'Read', 'Bash'].includes(e.name)) return false;
  return (str(e.input.file_path) || str(e.input.command)).includes('/scratchpad/');
}

function isBookkeeping(e: ToolEntry): boolean {
  return e.name === 'TodoWrite' || /^Task[A-Z]/.test(e.name);
}

function belongsInside(e: WorkEntry): boolean {
  if (e.type === 'thinking') return true;
  return isArtifactTool(e.name) || loadsArtifactTools(e) || touchesScratchpad(e) || isBookkeeping(e);
}

function opensRun(e: TimelineEntry): boolean {
  return e.type === 'tool' && (loadsArtifactTools(e) || touchesScratchpad(e));
}

const isDesignCall = (e: WorkEntry): e is ToolEntry => e.type === 'tool' && isArtifactTool(e.name);

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
  title: string | null;
  url: string | null;
  state: StepState;
}

/** A types listing carries links too, to the types' own pages, not this design. */
const OWN_ANSWER = /(?:^|__)(?:publish_files|publish_version|edit_version|create_from_type)$|^Artifact$/;

function field(text: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(text);
  return m ? m[1] : null;
}

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
