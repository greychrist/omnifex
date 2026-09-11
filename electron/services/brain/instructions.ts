import path from 'node:path';

/**
 * The MCP server's `instructions` string: what the Brain is, and when to reach
 * for it.
 *
 * This replaces a SessionStart hook (`<config_dir>/hooks/brain-directive.py`)
 * that did the same job from outside the app. That hook worked — measured
 * across real sessions, it took brain_search invocation from 9% to 50% — but
 * it paid for the result in three ways this does not:
 *
 *   - It reimplemented account -> vault -> index resolution in Python against
 *     OmniFex's own SQLite schema, as two hand-copied files, one per account.
 *     Here the server is already holding the vault it was handed.
 *   - It compared only the cwd's own basename against project links, so a
 *     session started in a subdirectory (`omnifex/electron`) was told nothing.
 *   - `additionalContext` lands in the conversation, where compaction can drop
 *     it mid-session. `instructions` lands in the system prompt and does not.
 *
 * Deliberately carries no note *content*. A table of contents for a 300-note
 * project would be several thousand tokens spent guessing at relevance before
 * the task is even known. Searching is the model's job; this only ensures it
 * knows there is something to search.
 */

// The bucket shape is the index's, re-exported rather than redeclared: two
// copies of it would drift the first time a column is added. Type-only, so
// this module still pulls in no SQLite at runtime.
import type { ProjectTypeCount } from './search';

export type { ProjectTypeCount };

/**
 * Ceiling on the whole string. Unlike a tool result, this is paid on every
 * session that connects the server, whether or not the Brain is ever touched —
 * so it is held to a budget rather than allowed to grow by accretion.
 */
export const MAX_INSTRUCTIONS_CHARS = 1600;

/** Ordered so the breakdown reads from durable knowledge to incidental. */
const TYPE_ORDER = ['Subsystem', 'Topic', 'Project', 'Note'];

/**
 * Fold a name to its comparison form — the same fold `project.ts` applies when
 * it assigns these links, and for the same reason: the checkout is `omnifex`
 * while the note is `Projects/OmniFex.md`, and `wombeats-ios` means
 * `WombBeats-iOS`.
 */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** `[[Projects/OmniFex]]` -> `OmniFex`. */
function projectName(link: string): string {
  return link.replace(/^\[\[Projects\//, '').replace(/\]\]$/, '');
}

/**
 * The project link owning this working directory, nearest ancestor first.
 *
 * Walks up rather than matching the basename alone: sessions are routinely
 * opened inside a package or a subdirectory of the repo, and those are exactly
 * the sessions doing the deep work a note is most likely to answer.
 */
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

/** "85 Subsystems, 124 Topics, 3 Notes", in TYPE_ORDER, unknown types last. */
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

/**
 * @param cwd The server's working directory, which the CLI sets to the
 *   session's. Null when it cannot be determined.
 * @param rows Every `(project, type)` bucket in the index.
 */
export function brainInstructions(cwd: string | null, rows: readonly ProjectTypeCount[]): string {
  const total = rows.reduce((n, row) => n + row.count, 0);
  if (total === 0) {
    // No knowledge to promise. Saying "search this" over an empty vault trains
    // the model to distrust the directive on the session where it is finally
    // worth something.
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
      : // Not silence: cross-cutting notes routinely answer a question asked
        // from a directory no project owns.
        `No notes are attributed to the current working directory, but the vault holds ${String(
          total,
        )} for this account and they often still apply.`;

  return [scope, WHAT_IT_IS, WHEN_TO_CALL, HOW_TO_QUERY, HOW_TO_CAPTURE].join('\n\n');
}
