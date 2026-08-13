/**
 * Claude Code's own auto-memory notes, ingested with NO model.
 *
 * These files are already what the vault wants: frontmatter, a description,
 * curated prose and `[[wikilinks]]` — the shape Rowboat converged on
 * independently, as the parent spec's Ontology section observed. Running them
 * through the extractor would spend a token to rewrite writing a human
 * deliberately curated, and lose the exact wording doing it. Extraction earns
 * its cost on a megabyte of transcript; here it destroys value.
 *
 * OmniFex never writes into a Claude config dir. This reads, only.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import type { AccountsService } from '../../accounts';
import { recoverProjectPath } from '../../project-paths';
import type { AdmitVerdict, BrainSource, SourceItem, TranslatedNote } from './types';

export const AUTO_MEMORY_SOURCE_ID = 'auto-memory';

/** The index file, which lists every sibling. Ingesting it duplicates them all. */
const INDEX_FILE = 'MEMORY.md';

/** A leading `---` fence, capturing the YAML and the remaining body. */
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface AutoMemoryFile {
  name: string;
  description: string;
  /** `user` | `feedback` | `project` | `reference`, or '' when absent. */
  memoryType: string;
  body: string;
}

/**
 * Pure, and never throws: anything unusable comes back null, which `admit`
 * turns into a visible reason rather than a failed scan.
 *
 * Deliberately NOT `frontmatter.ts`'s `parseNote`: that one validates against
 * the VAULT's schema, and an auto-memory file has a different one. Reusing it
 * would reject every input.
 */
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
 * One memory file becomes one note in `Notes/`, named after the SOURCE FILE,
 * not after its `name:` field.
 *
 * Two reasons, both measured on the real corpus (2026-08-12):
 *
 *  1. **The link graph points at filenames.** Memories link each other as
 *     `[[project_native_module_abi.md]]`, and `linkMatchesNote` binds by final
 *     segment with `.md` stripped. In 72 of 90 files the `name:` field is a
 *     human sentence that differs from the filename, so naming notes after it
 *     would break four fifths of the corpus's links.
 *  2. **A `name:` is untrusted input for a filesystem path.** Real values
 *     include `AWS cost reduction target ~$400/mo` and
 *     `Don't grandfather tech debt via baselines/ratchets` — using them as
 *     paths created nested directories inside `Notes/`. This is Plan 4a's
 *     lesson recurring at a different boundary: a name that came from outside
 *     is never a path.
 *
 * The human `name` is kept as an alias, so a search for the sentence still
 * finds the note.
 *
 * `metadata.originSessionId` is deliberately NOT recorded in `sources`. It is
 * a real provenance link, but `merge()` dedups by source key — a Note claiming
 * `session:<id>` would make a later index of that actual transcript believe it
 * was already covered, and the session's own note would never be written.
 */
export function translateAutoMemory(
  file: AutoMemoryFile,
  opts: { stem: string; sourceKey: string; date: string },
): TranslatedNote {
  const summary = file.description || 'Ingested from Claude Code auto-memory.';
  // The memory's own type becomes a searchable alias rather than a vault type:
  // `feedback` and `reference` have no NOTE_TYPES equivalent, and inventing one
  // would fork the ontology for four values.
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
    // A config dir with no projects yet is the ordinary state of a newly added
    // account, not an error. The Brain looks, and reports what is there.
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
          // Recovered from the project's transcripts, which sit beside
          // `memory/`. Once per project — it reads a file.
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
              continue; // Deleted between the readdir and the stat.
            }

            items.push({
              sourceId: AUTO_MEMORY_SOURCE_ID,
              // Project-qualified: a slug like `user_setup` recurs across
              // projects, and an unqualified key would collide between them.
              itemKey: `${project.name}/${entry.name}`,
              // Ownership is the config dir the file lives under, definitively
              // — the same rule as transcripts, and correct even when path
              // rules change afterwards.
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
      // No equivalent of the session gate's two-prompt rule: a memory file was
      // written deliberately, and the only thing rejected here is a file that
      // carries nothing usable.
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
          // The file's own mtime, so a re-translation of an unchanged file is
          // byte-identical rather than restamped with today's date.
          date: new Date(item.mtimeMs).toISOString().slice(0, 10),
        }),
      ]);
    },
  };
}
