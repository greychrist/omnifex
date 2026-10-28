/**
 * How the Modern format words a run of work, after shadcn's Trace examples:
 * each step is a sentence whose verb follows its state ("Reading c.ts",
 * "Read c.ts", "Failed to read c.ts"), and the run's header counts the steps
 * ("Worked in 5 steps, 1 failed") with the time beside it. Pure, so the
 * wording is tested without rendering.
 */

export type StepState = 'running' | 'done' | 'error';

export interface StepText {
  title: string;
  /** Secondary badges under the step: a host, a path, a subagent type. */
  badges?: string[];
  /** Draw the badges in the code face, as Trace does for file paths. */
  codeBadges?: boolean;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function basename(p: unknown): string {
  const s = str(p) ?? '';
  return s.split('/').filter(Boolean).pop() ?? s;
}

function host(url: unknown): string | undefined {
  try {
    return new URL(String(url)).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** [running, done, failed] forms of one verb. */
type Verb = readonly [string, string, string];
const READ: Verb = ['Reading', 'Read', 'Failed to read'];
const WRITE: Verb = ['Writing', 'Wrote', 'Failed to write'];
const EDIT: Verb = ['Editing', 'Edited', 'Failed to edit'];
const SEARCH: Verb = ['Searching', 'Searched', 'Failed to search'];
const FIND: Verb = ['Finding', 'Found', 'Failed to find'];
const RUN: Verb = ['Running', 'Ran', 'Failed to run'];
const USE: Verb = ['Using', 'Used', 'Failed to use'];
const LOAD: Verb = ['Loading', 'Loaded', 'Failed to load'];

function verb(v: Verb, state: StepState): string {
  return state === 'running' ? v[0] : state === 'error' ? v[2] : v[1];
}

function step(title: string, badges: (string | undefined)[] = [], codeBadges = false): StepText {
  const out: StepText = { title };
  const kept = badges.filter((b): b is string => !!b);
  if (kept.length > 0) {
    out.badges = kept;
    if (codeBadges) out.codeBadges = true;
  }
  return out;
}

export function describeToolStep(name: string, input: Record<string, unknown>, state: StepState): StepText {
  switch (name) {
    case 'Bash': {
      // The model's own description is already a sentence; it can't be
      // re-conjugated, so it stands as written.
      const description = str(input.description);
      if (description) return step(description);
      const command = (str(input.command) ?? '').split('\n')[0];
      return step(`${verb(RUN, state)} ${command || 'a command'}`);
    }
    case 'Read':
      return step(`${verb(READ, state)} ${basename(input.file_path)}`,
        [input.offset !== undefined ? `from line ${String(input.offset)}` : undefined]);
    case 'Write':
      return step(`${verb(WRITE, state)} ${basename(input.file_path)}`);
    case 'Edit':
    case 'MultiEdit':
      return step(`${verb(EDIT, state)} ${basename(input.file_path)}`);
    case 'Grep':
      return step(`${verb(SEARCH, state)} the code for ${str(input.pattern) ?? '…'}`, [str(input.path)], true);
    case 'Glob':
      return step(`${verb(FIND, state)} files matching ${str(input.pattern) ?? '…'}`);
    case 'WebSearch':
      return step(`${verb(SEARCH, state)} the web for ${str(input.query) ?? '…'}`);
    case 'WebFetch':
      return step(`${verb(READ, state)} a web page`, [host(input.url)]);
    case 'Agent':
    case 'Task':
      return step(str(input.description) ?? `${verb(RUN, state)} a subagent`, [str(input.subagent_type)]);
    case 'Skill':
      return step(`${verb(USE, state)} ${str(input.skill) ?? 'a skill'}`);
    case 'ToolSearch':
      return step(`${verb(LOAD, state)} tools`, [str(input.query)]);
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      return mcp ? step(mcp[2], [mcp[1]]) : step(name);
    }
  }
}

/** "32s", "1m 10s". */
export function shortDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** A finished run's header: its title, and the time it took beside it. */
export function traceHeader({
  steps,
  failed,
  ms,
}: {
  steps: number;
  failed: number;
  ms: number | null;
}): { title: string; description?: string } {
  const title = `Worked in ${steps} step${steps === 1 ? '' : 's'}${failed > 0 ? `, ${failed} failed` : ''}`;
  return ms !== null && ms >= 1000 ? { title, description: shortDuration(ms) } : { title };
}

/** shadcn Reasoning's line: "Thinking" while it thinks, "Thought for 5s" after. */
export function reasoningTitle({ running, ms }: { running: boolean; ms: number | null }): string {
  if (running) return 'Thinking';
  return ms !== null && ms >= 1000 ? `Thought for ${shortDuration(ms)}` : 'Thought';
}

/** A thought's token estimate as the classic card wrote it: "~608 tokens". */
export function thinkingTokensLabel(tokens: number): string {
  return `~${tokens.toLocaleString('en-US')} token${tokens === 1 ? '' : 's'}`;
}
