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
  /** The default must stay async: transcripts run to hundreds of MB on the event loop. */
  readFile?: (path: string) => string | Promise<string>;
}

export const SESSION_SOURCE_ID = 'session';

const MIN_PROMPTS = 2;

const UNREADABLE = 'transcript could not be read';

/** Bounded: flooding libuv's thread pool starves every other fs call. */
const STAT_CONCURRENCY = 8;

async function listDirSafe(path: string): Promise<{ name: string; isDirectory: boolean }[]> {
  try {
    return (await fsp.readdir(path, { withFileTypes: true })).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    }));
  } catch {
    return [];
  }
}

/** Ownership is the config dir a transcript lives under, never resolve(). */
export function createSessionSource(deps: SessionSourceDeps): BrainSource {
  const { accounts } = deps;
  const readFile = deps.readFile ?? ((path: string) => fsp.readFile(path, 'utf-8'));

  /** Keyed on hasChanged's fingerprint, so a transcript that grew is judged again. */
  const verdicts = new Map<string, { fingerprint: string; verdict: Promise<AdmitVerdict> }>();

  async function discover(): Promise<SourceItem[]> {
    // Keyed by account + session id: ids are unique only within an account.
    const bySession = new Map<string, { file: string; mtimeMs: number; size: number; label: string; accountId: number }[]>();

    for (const account of accounts.listAccounts()) {
      const projectsDir = join(account.config_dir, 'projects');

      for (const project of await listDirSafe(projectsDir)) {
        if (!project.isDirectory) continue;
        if (isSummaryScratchProject(project.name)) continue;
        const projectDir = join(projectsDir, project.name);
        const label = await recoverProjectPathAsync(projectDir, project.name);

        // Top-level .jsonl only: recursing would ingest subagent transcripts as sessions.
        const names = (await listDirSafe(projectDir))
          .filter((e) => !e.isDirectory && e.name.endsWith('.jsonl'))
          .map((e) => e.name);
        const stats = await mapLimit(names, STAT_CONCURRENCY, async (name) => {
          try {
            return await fsp.stat(join(projectDir, name));
          } catch {
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
      // mtime, not the first row's timestamp: discovery must not read the files.
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      const newest = files[files.length - 1];
      items.push({
        sourceId: SESSION_SOURCE_ID,
        itemKey: sessionId,
        accountId: newest.accountId,
        path: newest.file,
        paths: files.map((f) => f.file),
        mtimeMs: newest.mtimeMs,
        // The whole session's bytes: this column is the cost estimate.
        size: files.reduce((total, f) => total + f.size, 0),
        label: newest.label,
      });
    }

    return items;
  }

  /** Must tolerate a vanished file: discovery is a snapshot, not a lock. */
  async function distillItem(item: SourceItem): Promise<DistilledSession | null> {
    let jsonl: string;
    try {
      // Every file, in order: judging half a resumed conversation misreads it.
      const parts: string[] = [];
      for (const p of pathsOf(item)) parts.push(await readFile(p));
      jsonl = parts.join('\n');
    } catch {
      return null;
    }
    return distillTranscriptAsync(jsonl, item.itemKey);
  }

  function admit(item: SourceItem): Promise<AdmitVerdict> {
    const key = `${String(item.accountId)}:${item.itemKey}`;
    const fingerprint = `${pathsOf(item).join('\0')}\0${String(item.size)}\0${String(item.mtimeMs)}`;
    const known = verdicts.get(key);
    if (known?.fingerprint === fingerprint) return known.verdict;
    const verdict = judge(item);
    verdicts.set(key, { fingerprint, verdict });
    // Never cache an unreadable verdict: the file may be back by the next look.
    void verdict.then((v) => {
      if (v.reason === UNREADABLE && verdicts.get(key)?.verdict === verdict) verdicts.delete(key);
    });
    return verdict;
  }

  async function judge(item: SourceItem): Promise<AdmitVerdict> {
    const distilled = await distillItem(item);
    if (!distilled) return { admitted: false, reason: UNREADABLE };

    const { promptCount, proseCount, terminalStatus } = distilled.metadata;

    // Before the prompt count: a session that died on `Not logged in` also has one prompt.
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

  /** Rejects, never resolves empty: empty prose would yield a note saying the session held nothing. */
  async function distill(item: SourceItem): Promise<DistilledItem> {
    const distilled = await distillItem(item);
    if (!distilled) throw new Error(`cannot read transcript: ${item.path}`);
    return distilled;
  }

  return { id: SESSION_SOURCE_ID, discover, admit, distill };
}
