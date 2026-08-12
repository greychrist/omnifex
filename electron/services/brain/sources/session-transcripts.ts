import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountsService } from '../../accounts';
import { SCRATCH_DIR_NAME } from '../../sessions/summary-query';
import { distillTranscript } from '../distill';
import type { AdmitVerdict, BrainSource, DistilledItem, SourceItem } from './types';
import type { DistilledSession } from '../distill';

export interface SessionSourceDeps {
  accounts: AccountsService;
  /** Injectable so a test can drive the gate without a file on disk. */
  readFile?: (path: string) => string;
}

export const SESSION_SOURCE_ID = 'session';

/** Minimum prompts for a session to be worth a note (spec §7). */
const MIN_PROMPTS = 2;

/**
 * A project directory that is really OmniFex's own summary scratch.
 *
 * `sessions/summary-query.ts` pins every summary call to
 * `<os.tmpdir()>/omnifex-summary-scratch`, and the CLI encodes that cwd into a
 * `projects/<encoded>/` directory exactly like a user's repo. The encoding
 * replaces every non-alphanumeric character with `-`, so the scratch name
 * survives as a substring — which is what this matches. Anything stricter
 * would either miss it (exact match against an unencoded name) or be brittle
 * (reconstructing the whole encoded tmpdir path, which varies per machine).
 */
function isScratchProject(projectDirName: string): boolean {
  return projectDirName.includes(SCRATCH_DIR_NAME);
}

function listDirSafe(path: string): { name: string; isDirectory: boolean }[] {
  try {
    return readdirSync(path, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    }));
  } catch {
    // A config dir that does not exist yet is the ordinary state of a freshly
    // added account, not an error. The Brain is auxiliary: it looks, and if
    // there is nothing there it reports nothing there.
    return [];
  }
}

/**
 * The session-transcript source.
 *
 * Ownership comes from the config dir a transcript LIVES UNDER, via the
 * account list — never from `resolve()` (spec §4). That choice stays correct
 * even when path rules change after a session ran, and it is what stops a work
 * transcript from ever being indexed through the personal account: doing so
 * would push work content through the wrong subscription, a leak in the
 * opposite direction from the retrieval one.
 */
export function createSessionSource(deps: SessionSourceDeps): BrainSource {
  const { accounts } = deps;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf-8'));

  async function discover(): Promise<SourceItem[]> {
    const items: SourceItem[] = [];

    for (const account of accounts.listAccounts()) {
      const projectsDir = join(account.config_dir, 'projects');

      for (const project of listDirSafe(projectsDir)) {
        if (!project.isDirectory) continue;
        if (isScratchProject(project.name)) continue;
        const projectDir = join(projectsDir, project.name);

        for (const entry of listDirSafe(projectDir)) {
          // Top-level `.jsonl` only. `<sessionId>/` directories hold
          // `subagents/` and `tool-results/`; recursing would ingest a
          // subagent's conversation as if it were a user session.
          if (entry.isDirectory) continue;
          if (!entry.name.endsWith('.jsonl')) continue;

          const path = join(projectDir, entry.name);
          let stat;
          try {
            stat = statSync(path);
          } catch {
            // Deleted between the readdir and the stat. Nothing to index.
            continue;
          }

          items.push({
            sourceId: SESSION_SOURCE_ID,
            itemKey: entry.name.slice(0, -'.jsonl'.length),
            accountId: account.id,
            path,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            label: project.name,
          });
        }
      }
    }

    return items;
  }

  /**
   * Read and distil an item, or null when it cannot be read.
   *
   * `admit()` and `distill()` need the same parse, and both must tolerate a
   * file that vanished — sessions are deleted from the app's own UI, and a
   * discovery list is a snapshot, not a lock.
   */
  function distillItem(item: SourceItem): DistilledSession | null {
    try {
      return distillTranscript(readFile(item.path), item.itemKey);
    } catch {
      return null;
    }
  }

  /**
   * The admission gate: deterministic, no LLM (spec §7).
   *
   * These rules drop the open-a-tab-and-close-it noise that would otherwise
   * dominate the vault. Each returns the rule it fired on, because letting a
   * human check the gate's judgement before Plan 4 spends a token acting on it
   * is this build step's whole purpose.
   *
   * If precision proves inadequate, an LLM classifier slots in BEHIND this
   * same call — the interface does not change.
   */
  function admit(item: SourceItem): AdmitVerdict {
    const distilled = distillItem(item);
    if (!distilled) return { admitted: false, reason: 'transcript could not be read' };

    const { promptCount, proseCount, terminalStatus } = distilled.metadata;

    // Checked before the prompt count: a session that died on `Not logged in`
    // usually has exactly one prompt too, and "startup error" is the more
    // useful thing to tell the user. Bounded by proseCount so a long, healthy
    // session that hit one transient API error still qualifies.
    if (terminalStatus === 'error' && proseCount <= 1) {
      return { admitted: false, reason: 'terminated on a startup error' };
    }
    if (promptCount < MIN_PROMPTS) {
      return { admitted: false, reason: `fewer than ${MIN_PROMPTS} prompts (${promptCount})` };
    }
    if (proseCount === 0) {
      return { admitted: false, reason: 'no assistant prose' };
    }
    return {
      admitted: true,
      reason: `${promptCount} prompts, ${proseCount} assistant replies`,
    };
  }

  /**
   * The bounded prose Plan 4's extractor will run on.
   *
   * Rejects on an unreadable transcript rather than resolving with empty
   * prose. `admit()` can degrade to a verdict because "skip this" is a
   * truthful answer to a missing file; `distill()` has no such answer, and
   * empty prose would let the extractor write a note asserting the session
   * contained nothing.
   */
  async function distill(item: SourceItem): Promise<DistilledItem> {
    const distilled = distillItem(item);
    if (!distilled) throw new Error(`cannot read transcript: ${item.path}`);
    return distilled;
  }

  return { id: SESSION_SOURCE_ID, discover, admit, distill };
}
