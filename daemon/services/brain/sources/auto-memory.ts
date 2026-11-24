// Ingested without a model: rewriting human-curated memory destroys value. Read-only: never write into a Claude config dir.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import type { AccountsService } from '../../accounts';
import { recoverProjectPath } from '../../project-paths';
import type { AdmitVerdict, BrainSource, SourceItem, TranslatedNote } from './types';

export const AUTO_MEMORY_SOURCE_ID = 'auto-memory';

/** Never ingest it: it lists every sibling, duplicating them all. */
const INDEX_FILE = 'MEMORY.md';

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface AutoMemoryFile {
  name: string;
  description: string;
  memoryType: string;
  body: string;
}

/** Never throws. Not frontmatter.ts's parseNote: that validates the vault's schema, not this one. */
export function parseAutoMemory(raw: string, fallbackName: string): AutoMemoryFile | null {
  const match = FENCE.exec(raw);
  if (!match) return null;

  let loaded: unknown;
  try {
    loaded = load(match[1]) ?? {};
  } catch {
    return null;
  }
  if (typeof loaded !== 'object' || loaded === null) return null;

  const fm = loaded as { name?: unknown; description?: unknown; metadata?: unknown };
  const metadata = (
    typeof fm.metadata === 'object' && fm.metadata !== null ? fm.metadata : {}
  ) as { type?: unknown };

  const body = match[2].trim();
  if (!body) return null;

  return {
    name: typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : fallbackName,
    description: typeof fm.description === 'string' ? fm.description.trim() : '',
    memoryType: typeof metadata.type === 'string' ? metadata.type : '',
    body,
  };
}

/**
 * Named after the source file, not `name:`: memories link by filename, and `name:` is untrusted path input.
 * Never record originSessionId in `sources`: merge dedups by key, so the session's own note would never be written.
 */
export function translateAutoMemory(
  file: AutoMemoryFile,
  opts: { stem: string; sourceKey: string; date: string },
): TranslatedNote {
  const summary = file.description || 'Ingested from Claude Code auto-memory.';
  const aliases = [
    ...(file.name && file.name !== opts.stem ? [file.name] : []),
    ...(file.memoryType ? [file.memoryType] : []),
  ];
  return {
    relPath: `Notes/${opts.stem}.md`,
    note: {
      frontmatter: {
        type: 'Note',
        aliases,
        keywords: [],
        created: opts.date,
        updated: opts.date,
        sources: [opts.sourceKey],
      },
      body: `## Summary\n\n${summary}\n\n${file.body}\n`,
    },
  };
}

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

export function createAutoMemorySource(deps: { accounts: AccountsService }): BrainSource {
  function read(item: SourceItem): AutoMemoryFile | null {
    const stem = item.itemKey.split('/').pop()?.replace(/\.md$/, '') ?? item.itemKey;
    try {
      return parseAutoMemory(readFileSync(item.path, 'utf8'), stem);
    } catch {
      return null;
    }
  }

  return {
    id: AUTO_MEMORY_SOURCE_ID,

    discover(): Promise<SourceItem[]> {
      const items: SourceItem[] = [];
      for (const account of deps.accounts.listAccounts()) {
        const projectsDir = join(account.config_dir, 'projects');
        for (const project of listDirSafe(projectsDir)) {
          if (!project.isDirectory) continue;
          const memoryDir = join(projectsDir, project.name, 'memory');
          const label = recoverProjectPath(join(projectsDir, project.name), project.name);

          for (const entry of listDirSafe(memoryDir)) {
            if (entry.isDirectory) continue;
            if (!entry.name.endsWith('.md')) continue;
            if (entry.name === INDEX_FILE) continue;

            const path = join(memoryDir, entry.name);
            let stat;
            try {
              stat = statSync(path);
            } catch {
              continue;
            }

            items.push({
              sourceId: AUTO_MEMORY_SOURCE_ID,
              // Project-qualified: slugs like `user_setup` recur across projects.
              itemKey: `${project.name}/${entry.name}`,
              // Ownership is the config dir the file lives under, never resolve().
              accountId: account.id,
              path,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              label,
            });
          }
        }
      }
      return Promise.resolve(items);
    },

    admit(item: SourceItem): AdmitVerdict {
      const file = read(item);
      if (!file) return { admitted: false, reason: 'unreadable, or no YAML frontmatter fence' };
      return { admitted: true, reason: 'auto-memory note' };
    },

    translate(item: SourceItem): Promise<TranslatedNote[]> {
      const file = read(item);
      if (!file) return Promise.resolve([]);
      const stem = item.itemKey.split('/').pop()?.replace(/\.md$/, '') ?? item.itemKey;
      return Promise.resolve([
        translateAutoMemory(file, {
          stem,
          sourceKey: `${AUTO_MEMORY_SOURCE_ID}:${item.itemKey}`,
          // The file's own mtime, so re-translating an unchanged file stays byte-identical.
          date: new Date(item.mtimeMs).toISOString().slice(0, 10),
        }),
      ]);
    },
  };
}
