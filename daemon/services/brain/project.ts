import path from 'node:path';
import type { ItemMetadata } from './sources/types';

// Derived from the source path, never asked of the model: the field is an exact-match filter.

/** Same shape as resolve.ts's fold, deliberately not shared: they fold different things. */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sourcePath(metadata: ItemMetadata): string | null {
  switch (metadata.kind) {
    case 'session':
      return metadata.projectPath;
    case 'capture':
      return metadata.cwd;
    case 'artifact':
      return metadata.repoPath;
    default: {
      // Exhaustive: a new source kind must decide its project, never fall through unattributed.
      const _never: never = metadata;
      return _never;
    }
  }
}

export interface ExistingProject {
  title: string;
  aliases: string[];
}

/** Undefined, never a guess: merge then keeps an earlier run's attribution. */
export function projectLinkFor(
  metadata: ItemMetadata,
  projects: ExistingProject[],
): string | undefined {
  const from = sourcePath(metadata);
  if (!from) return undefined;

  const dir = path.basename(from.replace(/[/\\]+$/, ''));
  if (!dir) return undefined;

  const key = fold(dir);
  if (!key) return undefined;

  // Sorted so the result is independent of listing order: this must stay pure across re-indexing.
  const sorted = [...projects].sort((a, b) => a.title.localeCompare(b.title));

  // Title before alias, as in resolve.ts.
  const byTitle = sorted.find((p) => fold(p.title) === key);
  const match = byTitle ?? sorted.find((p) => p.aliases.some((a) => fold(a) === key));

  return `[[Projects/${match?.title ?? dir}]]`;
}
