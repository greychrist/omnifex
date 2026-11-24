import path from 'node:path';

/**
 * Replaces a SessionStart hook: `instructions` lands in the system prompt, where compaction
 * cannot drop it, and the server already holds its vault. Carries no note content.
 */

// Type-only: this module must pull in no SQLite at runtime.
import type { ProjectTypeCount } from './search';

export type { ProjectTypeCount };

/** Paid by every session that connects the server, so held to a budget. */
export const MAX_INSTRUCTIONS_CHARS = 1600;

const TYPE_ORDER = ['Subsystem', 'Topic', 'Project', 'Note'];

/** Must match project.ts's fold. */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function projectName(link: string): string {
  return link.replace(/^\[\[Projects\//, '').replace(/\]\]$/, '');
}

function linkForCwd(cwd: string, links: readonly string[]): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const folded = fold(path.basename(dir));
    const match = links.find((link) => fold(projectName(link)) === folded);
    if (match !== undefined) return match;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

function breakdown(rows: readonly ProjectTypeCount[]): string {
  const byType = new Map<string, number>();
  for (const row of rows) byType.set(row.type, (byType.get(row.type) ?? 0) + row.count);
  const known = TYPE_ORDER.filter((t) => byType.has(t));
  const extra = [...byType.keys()].filter((t) => !TYPE_ORDER.includes(t)).sort();
  return [...known, ...extra].map((t) => plural(byType.get(t) ?? 0, t)).join(', ');
}

const WHAT_IT_IS =
  "The OmniFex Brain is this account's memory of its own past Claude Code sessions: how " +
  'subsystems actually behave, decisions and the reasons behind them, constraints, and bugs ' +
  'already diagnosed once. It is neither documentation nor the code, and nothing injects it ' +
  'into a session automatically.';

const WHEN_TO_CALL =
  'Call brain_search before you explain how a subsystem works, diagnose a bug, change code ' +
  'whose present shape looks odd, or tell the user something is new. Reaching for it after an ' +
  'hour of tracing is the common failure — rediscovering what a note already records costs far ' +
  'more than reading it.';

const HOW_TO_QUERY =
  'Name identifiers, file paths, symbols or error text rather than describing. Terms are ORed ' +
  'and ranked, so extra words widen the search rather than narrowing it; two to five terms ' +
  'works best. Hits carry the note text inline — call brain_read only for a hit marked ' +
  'truncated.';

const HOW_TO_CAPTURE =
  'Use brain_remember for what will still matter in six months: a decision and its reason, a ' +
  'constraint, a gotcha that cost real time. It queues, and becomes a note after this session ' +
  'ends.';

/** `cwd` is the server's, which the CLI sets to the session's; null when unknown. */
export function brainInstructions(cwd: string | null, rows: readonly ProjectTypeCount[]): string {
  const total = rows.reduce((n, row) => n + row.count, 0);
  if (total === 0) {
    // Never promise knowledge over an empty vault: it trains the model to distrust the directive.
    return `${WHAT_IT_IS} It holds no notes yet. ${HOW_TO_CAPTURE}`;
  }

  const links = [...new Set(rows.map((r) => r.project))].filter((p) => p !== '');
  const link = cwd === null ? null : linkForCwd(cwd, links);
  const mine = link === null ? [] : rows.filter((r) => r.project === link);

  const scope =
    link !== null
      ? `This project (${projectName(link)}) has ${plural(
          mine.reduce((n, row) => n + row.count, 0),
          'note',
        )} in the vault: ${breakdown(mine)}.`
      : // Not silence: cross-cutting notes answer questions from any directory.
        `No notes are attributed to the current working directory, but the vault holds ${String(
          total,
        )} for this account and they often still apply.`;

  return [scope, WHAT_IT_IS, WHEN_TO_CALL, HOW_TO_QUERY, HOW_TO_CAPTURE].join('\n\n');
}
