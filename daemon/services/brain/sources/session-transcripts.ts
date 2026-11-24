import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { AccountsService } from '../../accounts';
import { isSummaryScratchProject } from '../../sessions/internal-spend';
import { recoverProjectPathAsync } from '../../project-paths';
import { mapLimit } from '../../util/map-limit';
import { distillTranscriptAsync } from '../distill';
import { pathsOf, type AdmitVerdict, type BrainSource, type DistilledItem, type SourceItem } from './types';
import type { DistilledSession } from '../distill';

export interface SessionSourceDeps {
  accounts: AccountsService;
  /**
   * Injectable so a test can drive the gate without a file on disk. The
   * default reads through the thread pool: a transcript runs to hundreds of
   * MB, and this runs on the event loop that streams every live session.
   */
  readFile?: (path: string) => string | Promise<string>;
}

export const SESSION_SOURCE_ID = 'session';

/** Minimum prompts for a session to be worth a note (spec §7). */
const MIN_PROMPTS = 2;

const UNREADABLE = 'transcript could not be read';

/**
 * Concurrent stats during discovery. Async fs runs on libuv's small thread
 * pool; flooding it with every transcript at once would starve every other fs
 * call the daemon makes meanwhile.
 */
const STAT_CONCURRENCY = 8;

async function listDirSafe(path: string): Promise<{ name: string; isDirectory: boolean }[]> {
  try {
    return (await fsp.readdir(path, { withFileTypes: true })).map((e) => ({
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
  const readFile = deps.readFile ?? ((path: string) => fsp.readFile(path, 'utf-8'));

  /**
   * Gate verdicts already reached, per item, with the fingerprint they were
   * reached at. The Sources pane asks for every item's verdict on each open,
   * and the verdict is a pure function of the bytes: without this, every open
   * re-read and re-parsed the account's whole history (0.7–1.4 GB). Keyed on
   * the same evidence `hasChanged`'s fast path trusts — the files, their total
   * size and the newest mtime — so a transcript that grew is judged again.
   * In memory only; one entry per session is a few dozen bytes.
   */
  const verdicts = new Map<string, { fingerprint: string; verdict: Promise<AdmitVerdict> }>();

  async function discover(): Promise<SourceItem[]> {
    // Keyed by account + session id, because a session id is unique only
    // within an account: two accounts may hold the same id, and joining those
    // would put one account's conversation into the other's vault.
    const bySession = new Map<string, { file: string; mtimeMs: number; size: number; label: string; accountId: number }[]>();

    for (const account of accounts.listAccounts()) {
      const projectsDir = join(account.config_dir, 'projects');

      for (const project of await listDirSafe(projectsDir)) {
        if (!project.isDirectory) continue;
        if (isSummaryScratchProject(project.name)) continue;
        const projectDir = join(projectsDir, project.name);
        // Once per project, not once per transcript: this reads a file, and a
        // busy project holds hundreds of them.
        const label = await recoverProjectPathAsync(projectDir, project.name);

        // Top-level `.jsonl` only. `<sessionId>/` directories hold
        // `subagents/` and `tool-results/`; recursing would ingest a
        // subagent's conversation as if it were a user session.
        const names = (await listDirSafe(projectDir))
          .filter((e) => !e.isDirectory && e.name.endsWith('.jsonl'))
          .map((e) => e.name);
        const stats = await mapLimit(names, STAT_CONCURRENCY, async (name) => {
          try {
            return await fsp.stat(join(projectDir, name));
          } catch {
            // Deleted between the readdir and the stat. Nothing to index.
            return null;
          }
        });

        names.forEach((name, i) => {
          const stat = stats[i];
          if (!stat) return;
          const sessionId = name.slice(0, -'.jsonl'.length);
          const key = `${String(account.id)}:${sessionId}`;
          const group = bySession.get(key) ?? [];
          group.push({
            file: join(projectDir, name),
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            label,
            accountId: account.id,
          });
          bySession.set(key, group);
        });
      }
    }

    const items: SourceItem[] = [];
    for (const [key, files] of bySession) {
      const sessionId = key.slice(key.indexOf(':') + 1);
      // Oldest first, which is the order the conversation was had. mtime is
      // the proxy rather than the first row's timestamp on purpose: discovery
      // walks hundreds of files per account and must not read any of them.
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      const newest = files[files.length - 1];
      items.push({
        sourceId: SESSION_SOURCE_ID,
        itemKey: sessionId,
        accountId: newest.accountId,
        // The newest file's project: where the conversation currently lives,
        // and therefore the project this item is grouped and excluded under.
        path: newest.file,
        paths: files.map((f) => f.file),
        mtimeMs: newest.mtimeMs,
        // The whole session's bytes. Half of it would understate what indexing
        // this item is about to cost, which is what the column is FOR.
        size: files.reduce((total, f) => total + f.size, 0),
        label: newest.label,
      });
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
  async function distillItem(item: SourceItem): Promise<DistilledSession | null> {
    let jsonl: string;
    try {
      // Every file, in order: the halves of a resumed conversation are one
      // transcript, and judging or distilling either alone misreads it — a
      // two-prompt session split one-and-one would fail the gate twice.
      const parts: string[] = [];
      for (const p of pathsOf(item)) parts.push(await readFile(p));
      jsonl = parts.join('\n');
    } catch {
      return null;
    }
    return distillTranscriptAsync(jsonl, item.itemKey);
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
  function admit(item: SourceItem): Promise<AdmitVerdict> {
    const key = `${String(item.accountId)}:${item.itemKey}`;
    const fingerprint = `${pathsOf(item).join('\0')}\0${String(item.size)}\0${String(item.mtimeMs)}`;
    const known = verdicts.get(key);
    if (known?.fingerprint === fingerprint) return known.verdict;
    const verdict = judge(item);
    verdicts.set(key, { fingerprint, verdict });
    // An unreadable transcript is not a verdict worth keeping: the file may be
    // back (or finished being written) by the next look.
    void verdict.then((v) => {
      if (v.reason === UNREADABLE && verdicts.get(key)?.verdict === verdict) verdicts.delete(key);
    });
    return verdict;
  }

  async function judge(item: SourceItem): Promise<AdmitVerdict> {
    const distilled = await distillItem(item);
    if (!distilled) return { admitted: false, reason: UNREADABLE };

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
    const distilled = await distillItem(item);
    if (!distilled) throw new Error(`cannot read transcript: ${item.path}`);
    return distilled;
  }

  return { id: SESSION_SOURCE_ID, discover, admit, distill };
}
