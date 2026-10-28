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
      // What ran, as Trace words it ("Ran pnpm --version"); the model's own
      // description of the command is the line's tooltip.
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

/** What a step does, which picks its icon. Status is the line's colour and
 *  title, never the icon — as in shadcn's Trace. */
export type StepKind =
  | 'command' | 'commit' | 'branch' | 'read' | 'edit' | 'create' | 'search' | 'explore'
  | 'web' | 'agent' | 'tasks' | 'question' | 'skill' | 'mcp' | 'tool';

export function stepKind(name: string, input: Record<string, unknown>): StepKind {
  switch (name) {
    case 'Bash': {
      const command = str(input.command) ?? '';
      if (/\bgit\s+commit\b/.test(command)) return 'commit';
      if (/\bgit\s+(checkout\s+-b|switch\s+-c)\b/.test(command)) return 'branch';
      return 'command';
    }
    case 'Read': return 'read';
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return 'edit';
    case 'Write': return 'create';
    case 'Grep': return 'search';
    case 'Glob': case 'LS': return 'explore';
    case 'WebSearch': case 'WebFetch': return 'web';
    case 'Agent': case 'Task': return 'agent';
    case 'AskUserQuestion': return 'question';
    case 'Skill': return 'skill';
    default:
      if (name === 'TodoWrite' || /^Task[A-Z]/.test(name)) return 'tasks';
      return name.startsWith('mcp__') ? 'mcp' : 'tool';
  }
}

export interface WebSource { title: string; url: string }

/** The pages a web step used: the one a fetch read, or the links a search
 *  returned (its result carries them as `Links: [{title,url}…]` sections). */
export function webSources(name: string, input: Record<string, unknown>, resultText: string | undefined): WebSource[] {
  if (name === 'WebFetch') {
    const url = str(input.url);
    return url ? [{ title: host(url) ?? url, url }] : [];
  }
  if (name !== 'WebSearch' || !resultText) return [];
  const out: WebSource[] = [];
  for (const part of resultText.split(/Links:\s*\[/).slice(1)) {
    const end = part.indexOf(']');
    if (end === -1) continue;
    try {
      const links: unknown = JSON.parse('[' + part.slice(0, end + 1));
      if (!Array.isArray(links)) continue;
      for (const l of links) {
        const { title, url } = (l ?? {}) as { title?: unknown; url?: unknown };
        if (typeof url === 'string') out.push({ title: typeof title === 'string' && title ? title : url, url });
      }
    } catch {
      // Not the shape we know; the step shows no sources rather than garbage.
    }
  }
  return out;
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
