/**
 * A repository's agent instruction files — `CLAUDE.md` and `AGENTS.md`.
 *
 * The file itself is already in the model's context in every session in that
 * repo, so storing it verbatim would add nothing. Extracting it seeds
 * `Projects/<repo>` and Subsystem notes that session-derived entities then
 * merge INTO, and seeding that ontology is the actual argument for indexing
 * artifacts at all.
 *
 * `README`, `CHANGELOG` and `docs/` are deliberately excluded: the first two
 * are public-facing or generated, and this repo's `docs/` holds 100KB+ plan
 * files that would dominate the corpus while restating sessions already
 * indexed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AccountsService } from '../../accounts';
import type { AdmitVerdict, BrainSource, DistilledItem, SourceItem } from './types';

export const REPO_SOURCE_ID = 'repo';

const ARTIFACT_NAMES = new Set(['CLAUDE.md', 'AGENTS.md']);

/** Same ceiling the session distiller uses, for the same reason. */
const MAX_PROSE_BYTES = 8 * 1024;
const TRUNCATION_MARKER = '[… truncated to fit the size limit …]';

/** Directories never worth walking for instruction files. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'coverage']);

/** How deep to walk for nested instruction files. Root plus three levels. */
const MAX_DEPTH = 3;

/** Bytes of a transcript read while looking for a `cwd`. */
const CWD_SCAN_BYTES = 256 * 1024;

function listDirSafe(path: string): { name: string; isDirectory: boolean }[] {
  try {
    return readdirSync(path, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    }));
  } catch {
    return [];
  }
}

/**
 * The repo path a project directory's transcripts actually ran in.
 *
 * NOT decoded from the directory name. The CLI's encoding replaces every
 * non-alphanumeric character with `-`, so `wombeats-ios` and `wombeats/ios`
 * encode identically — decoding `-Users-dev-Repos-wombeats-ios` naively yields
 * `/Users/dev/Repos/wombeats/ios`, a path that does not exist. A transcript's
 * own `cwd` is the only authority on where its session ran.
 */
export function repoPathFromTranscripts(
  projectDir: string,
  readChunk: (path: string) => string = (path) =>
    readFileSync(path, 'utf8').slice(0, CWD_SCAN_BYTES),
): string | null {
  for (const entry of listDirSafe(projectDir)) {
    if (entry.isDirectory || !entry.name.endsWith('.jsonl')) continue;

    let chunk: string;
    try {
      chunk = readChunk(join(projectDir, entry.name));
    } catch {
      continue;
    }

    for (const line of chunk.split('\n')) {
      // Cheap reject before the parse: most rows carry no cwd at all.
      if (!line.includes('"cwd"')) continue;
      try {
        const row = JSON.parse(line) as { cwd?: unknown };
        if (typeof row.cwd === 'string' && row.cwd) return row.cwd;
      } catch {
        // A truncated final line from the byte-bounded read. Keep looking.
      }
    }
  }
  return null;
}

function findArtifacts(root: string, dir: string, depth: number, out: string[]): void {
  for (const entry of listDirSafe(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory) {
      if (depth >= MAX_DEPTH || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      findArtifacts(root, full, depth + 1, out);
      continue;
    }
    if (ARTIFACT_NAMES.has(entry.name)) out.push(relative(root, full));
  }
}

export function createRepoArtifactSource(deps: { accounts: AccountsService }): BrainSource {
  /** `<repoPath>:<repo-relative file>` — unique, and readable in the tab. */
  function splitKey(itemKey: string): { repoPath: string; file: string } {
    const idx = itemKey.lastIndexOf(':');
    return { repoPath: itemKey.slice(0, idx), file: itemKey.slice(idx + 1) };
  }

  return {
    id: REPO_SOURCE_ID,

    discover(): Promise<SourceItem[]> {
      const items: SourceItem[] = [];
      const seenRepos = new Set<string>();

      for (const account of deps.accounts.listAccounts()) {
        const projectsDir = join(account.config_dir, 'projects');

        for (const project of listDirSafe(projectsDir)) {
          if (!project.isDirectory) continue;

          const repoPath = repoPathFromTranscripts(join(projectsDir, project.name));
          // No cwd in any transcript means no known path. Skipped, never guessed.
          if (!repoPath || seenRepos.has(repoPath)) continue;
          seenRepos.add(repoPath);

          // Ownership is `resolve()` on the repo, per spec §4 — NOT the config
          // dir this repo happened to be found through. An unresolved repo is
          // omitted: an adapter that cannot determine ownership must not guess,
          // because guessing writes one account's material into another's vault.
          const owner = deps.accounts.resolve(repoPath).claude?.account;
          if (!owner) continue;

          const files: string[] = [];
          findArtifacts(repoPath, repoPath, 0, files);

          for (const file of files) {
            const path = join(repoPath, file);
            let stat;
            try {
              stat = statSync(path);
            } catch {
              continue;
            }
            items.push({
              sourceId: REPO_SOURCE_ID,
              itemKey: `${repoPath}:${file}`,
              accountId: owner.id,
              path,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              label: file,
            });
          }
        }
      }
      return Promise.resolve(items);
    },

    admit(item: SourceItem): AdmitVerdict {
      let contents: string;
      try {
        contents = readFileSync(item.path, 'utf8');
      } catch {
        return { admitted: false, reason: 'instruction file could not be read' };
      }
      if (!contents.trim()) return { admitted: false, reason: 'instruction file is empty' };
      return { admitted: true, reason: 'agent instruction file' };
    },

    distill(item: SourceItem): Promise<DistilledItem> {
      const { repoPath, file } = splitKey(item.itemKey);
      const contents = readFileSync(item.path, 'utf8');
      const truncated = Buffer.byteLength(contents, 'utf8') > MAX_PROSE_BYTES;
      // Head-first, unlike a transcript's oldest-first tail: an instruction
      // file's opening sections state what the project IS, so dropping the end
      // loses detail while dropping the start would lose the subject.
      const prose = truncated
        ? `${contents.slice(0, MAX_PROSE_BYTES)}\n\n${TRUNCATION_MARKER}`
        : contents;

      return Promise.resolve({
        prose,
        truncated,
        metadata: { kind: 'artifact', repoPath, file },
      });
    },
  };
}
