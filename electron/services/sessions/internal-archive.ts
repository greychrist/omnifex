// Where OmniFex's own CLI transcripts go to be kept.
//
// OmniFex spends real money on the user's account through `runCliOnce` —
// session summaries, Brain indexing, Brain curation — and until this module
// existed it deleted the evidence: the runner `rm -rf`'d the transcript the
// CLI wrote as soon as the call returned.
//
// That sweep raced the cost watcher, so whether a given internal run was ever
// priced came down to which won. The result was a cost table holding a
// non-deterministic fraction of OmniFex's own spend, which is worse than
// holding none of it — it looks like data.
//
// Design: docs/superpowers/specs/2026-08-26-internal-session-archive-design.md

import path from 'path';

export const ARCHIVE_ROOT_NAME = 'internal-sessions';

/** Every kind of internal run that costs money. A run that cannot say which
 *  one it is cannot be attributed, so callers must pass this — the Brain's
 *  own ledger refuses `'unknown'` for the same reason. */
export const INTERNAL_KINDS = ['session-summarization', 'brain-index', 'brain-curation'] as const;
export type InternalKind = (typeof INTERNAL_KINDS)[number];

/**
 * Display label for a kind. This doubles as the row's `project_path`, so
 * `shortProject()` — which renders the last two segments — shows
 * "OmniFex/Brain index" in every existing table with no renderer change.
 *
 * The slash is load-bearing for that reason; don't "tidy" these into
 * single words.
 */
export const INTERNAL_LABEL: Record<InternalKind, string> = {
  'session-summarization': 'OmniFex/Session summarization',
  'brain-index': 'OmniFex/Brain index',
  'brain-curation': 'OmniFex/Brain curation',
};

/** `<userData>/internal-sessions`. Deliberately OmniFex's own directory and
 *  not the Claude config dir: this is our data, it is safe to delete
 *  wholesale, and it can never be mistaken for a user's project. */
export function internalArchiveRoot(userDataPath: string): string {
  return path.join(userDataPath, ARCHIVE_ROOT_NAME);
}

/**
 * Collapse an account name to one safe path segment.
 *
 * Account names are user-supplied and land on the filesystem here, so a name
 * containing a separator or a leading dot must not be able to steer the write
 * out of the archive. Leading dots go too: `..` would escape the root, and a
 * dotfile directory would be invisible in the Clear UI.
 */
function segment(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return cleaned.length > 0 ? cleaned : '_';
}

/**
 * `<root>/<account>/<kind>/<YYYY-MM-DD>`.
 *
 * Date-partitioned because retention prunes by age: dropping a whole date
 * directory is one `rm` and cannot half-delete a day, where reading mtimes
 * out of thousands of files could.
 */
export function archiveDirFor(
  root: string,
  accountName: string,
  kind: InternalKind,
  date: string,
): string {
  return path.join(root, segment(accountName), kind, date);
}

/**
 * The filesystem surface the move needs. Injected so the failure paths — a
 * cross-device rename, a copy that fails — can be tested without contriving
 * them on a real disk.
 */
export interface ArchiveFs {
  mkdir(dir: string, opts?: { recursive: boolean }): Promise<unknown>;
  readdir(dir: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  unlink(p: string): Promise<void>;
  stat(p: string): Promise<{ size: number }>;
}

export interface ArchiveTranscriptsParams {
  fs: ArchiveFs;
  /** `<configDir>/projects/<encoded-scratch>` — where the CLI wrote. */
  projectsDir: string;
  /** `archiveDirFor(...)` — where it should end up. */
  destDir: string;
}

export interface ArchiveResult {
  /** Destination paths that now hold a transcript. */
  moved: string[];
  /** Source paths still sitting in the scratch dir. Never deleted. */
  failed: string[];
}

/**
 * Move every transcript out of the CLI's scratch projects directory into the
 * archive.
 *
 * Move, never copy: two copies of a billable transcript on disk is how
 * double-counting starts, since the ingest would price both.
 *
 * A file that cannot be moved is REPORTED, not deleted. That asymmetry is the
 * whole safety property here — the previous implementation deleted
 * unconditionally, and a transcript is the only local record that a paid call
 * ever happened. Losing one loses money from the report permanently.
 */
export async function archiveTranscripts(p: ArchiveTranscriptsParams): Promise<ArchiveResult> {
  const { fs, projectsDir, destDir } = p;

  let names: string[];
  try {
    names = await fs.readdir(projectsDir);
  } catch {
    // The directory does not exist, which is the ordinary state when the CLI
    // failed before writing anything. Nothing to do is not an error.
    return { moved: [], failed: [] };
  }

  const transcripts = names.filter((n) => n.endsWith('.jsonl'));
  if (transcripts.length === 0) return { moved: [], failed: [] };

  await fs.mkdir(destDir, { recursive: true });

  const moved: string[] = [];
  const failed: string[] = [];

  for (const name of transcripts) {
    const from = path.join(projectsDir, name);
    const to = path.join(destDir, name);
    try {
      await fs.rename(from, to);
      moved.push(to);
    } catch {
      // rename fails with EXDEV when userData and tmp are on different
      // volumes — ordinary, not exceptional. Copy, confirm the destination is
      // really there, and only then remove the source.
      try {
        await fs.copyFile(from, to);
        await fs.stat(to);
        await fs.unlink(from);
        moved.push(to);
      } catch {
        failed.push(from);
      }
    }
  }

  return { moved, failed };
}
