// README, CHANGELOG and docs/ are deliberately not indexed: they would dominate the corpus.
import { promises as fsp } from 'node:fs';
import { join, relative } from 'node:path';
import type { AccountsService } from '../../accounts';
import type { AdmitVerdict, BrainSource, DistilledItem, SourceItem } from './types';

export const REPO_SOURCE_ID = 'repo';

const ARTIFACT_NAMES = new Set(['CLAUDE.md', 'AGENTS.md']);

const MAX_PROSE_BYTES = 8 * 1024;
const TRUNCATION_MARKER = '[… truncated to fit the size limit …]';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'coverage']);

const MAX_DEPTH = 3;

const CWD_SCAN_BYTES = 256 * 1024;

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

/** Never decode the directory name: the CLI's encoding is lossy, so a transcript's own cwd is the authority. */
export async function repoPathFromTranscripts(
  projectDir: string,
  readChunk: (path: string) => Promise<string> = readHead,
): Promise<string | null> {
  for (const entry of await listDirSafe(projectDir)) {
    if (entry.isDirectory || !entry.name.endsWith('.jsonl')) continue;

    let chunk: string;
    try {
      chunk = await readChunk(join(projectDir, entry.name));
    } catch {
      continue;
    }

    for (const line of chunk.split('\n')) {
      if (!line.includes('"cwd"')) continue;
      try {
        const row = JSON.parse(line) as { cwd?: unknown };
        if (typeof row.cwd === 'string' && row.cwd) return row.cwd;
      } catch {
        // Truncated final line from the bounded read.
      }
    }
  }
  return null;
}

/** Bounded at the read: never read a whole transcript on the event loop. */
async function readHead(path: string): Promise<string> {
  const handle = await fsp.open(path, 'r');
  try {
    const buf = Buffer.alloc(CWD_SCAN_BYTES);
    let read = 0;
    while (read < CWD_SCAN_BYTES) {
      const { bytesRead } = await handle.read(buf, read, CWD_SCAN_BYTES - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buf.subarray(0, read).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function findArtifacts(root: string, dir: string, depth: number, out: string[]): Promise<void> {
  for (const entry of await listDirSafe(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory) {
      if (depth >= MAX_DEPTH || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await findArtifacts(root, full, depth + 1, out);
      continue;
    }
    if (ARTIFACT_NAMES.has(entry.name)) out.push(relative(root, full));
  }
}

export function createRepoArtifactSource(deps: { accounts: AccountsService }): BrainSource {
  function splitKey(itemKey: string): { repoPath: string; file: string } {
    const idx = itemKey.lastIndexOf(':');
    return { repoPath: itemKey.slice(0, idx), file: itemKey.slice(idx + 1) };
  }

  return {
    id: REPO_SOURCE_ID,

    async discover(): Promise<SourceItem[]> {
      const items: SourceItem[] = [];
      const seenRepos = new Set<string>();

      for (const account of deps.accounts.listAccounts()) {
        const projectsDir = join(account.config_dir, 'projects');

        for (const project of await listDirSafe(projectsDir)) {
          if (!project.isDirectory) continue;

          const repoPath = await repoPathFromTranscripts(join(projectsDir, project.name));
          if (!repoPath || seenRepos.has(repoPath)) continue;
          seenRepos.add(repoPath);

          // Ownership is resolve() on the repo. Unresolved is omitted, never guessed into another account's vault.
          const owner = deps.accounts.resolve(repoPath).claude?.account;
          if (!owner) continue;

          const files: string[] = [];
          await findArtifacts(repoPath, repoPath, 0, files);

          for (const file of files) {
            const path = join(repoPath, file);
            let stat;
            try {
              stat = await fsp.stat(path);
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
              // The repo, never the file: grouping and exclusions key on this label.
              label: repoPath,
            });
          }
        }
      }
      return items;
    },

    async admit(item: SourceItem): Promise<AdmitVerdict> {
      let contents: string;
      try {
        contents = await fsp.readFile(item.path, 'utf8');
      } catch {
        return { admitted: false, reason: 'instruction file could not be read' };
      }
      if (!contents.trim()) return { admitted: false, reason: 'instruction file is empty' };
      return { admitted: true, reason: 'agent instruction file' };
    },

    async distill(item: SourceItem): Promise<DistilledItem> {
      const { repoPath, file } = splitKey(item.itemKey);
      const contents = await fsp.readFile(item.path, 'utf8');
      const truncated = Buffer.byteLength(contents, 'utf8') > MAX_PROSE_BYTES;
      // Head-first: an instruction file's opening says what the project is.
      const prose = truncated
        ? `${contents.slice(0, MAX_PROSE_BYTES)}\n\n${TRUNCATION_MARKER}`
        : contents;

      return {
        prose,
        truncated,
        metadata: { kind: 'artifact', repoPath, file },
      };
    },
  };
}
