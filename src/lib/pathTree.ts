/**
 * Fold a flat list of repo-relative paths into a directory tree for the diff
 * navigator.
 *
 * Pure and generic over the entry type so the tree carries whatever the caller
 * needs on a row — a `ChangedFile` here — without this module knowing about
 * git.
 *
 * Single-child directory chains collapse into one node (`a/b/c` rather than
 * three nested rows). A changed-file tree is usually sparse: one edit deep
 * inside `src/components/settings-panels/appearance/` would otherwise spend
 * five rows to say "here", which is the main reason a plain tree reads badly
 * for diffs and well for a file browser.
 */

export interface TreeFileNode<T> {
  kind: 'file';
  /** Last path segment — what the row shows. */
  name: string;
  /** Full repo-relative path. */
  path: string;
  entry: T;
}

export interface TreeDirNode<T> {
  kind: 'dir';
  /** Segment, or several joined by `/` when a chain was collapsed. */
  name: string;
  /** Full path of the deepest segment this node represents. */
  path: string;
  children: TreeNode<T>[];
}

export type TreeNode<T> = TreeFileNode<T> | TreeDirNode<T>;

interface MutableDir<T> {
  dirs: Map<string, MutableDir<T>>;
  files: { name: string; path: string; entry: T }[];
}

function emptyDir<T>(): MutableDir<T> {
  return { dirs: new Map(), files: [] };
}

/** Case-insensitive, then case-sensitive so ordering is stable and total. */
function compareNames(a: string, b: string): number {
  const lowered = a.toLowerCase().localeCompare(b.toLowerCase());
  return lowered !== 0 ? lowered : a.localeCompare(b);
}

function materialize<T>(dir: MutableDir<T>, prefix: string): TreeNode<T>[] {
  const out: TreeNode<T>[] = [];

  const dirNames = [...dir.dirs.keys()].sort(compareNames);
  for (const name of dirNames) {
    const child = dir.dirs.get(name) as MutableDir<T>;
    let displayName = name;
    let path = prefix ? `${prefix}/${name}` : name;
    let node = child;

    // Collapse while this directory holds exactly one directory and nothing
    // else. A lone FILE does not collapse — `src/top.ts` must still show
    // `src` as a directory the reader can fold.
    while (node.files.length === 0 && node.dirs.size === 1) {
      const [onlyName] = [...node.dirs.keys()];
      node = node.dirs.get(onlyName) as MutableDir<T>;
      displayName = `${displayName}/${onlyName}`;
      path = `${path}/${onlyName}`;
    }

    out.push({ kind: 'dir', name: displayName, path, children: materialize(node, path) });
  }

  const sortedFiles = [...dir.files].sort((a, b) => compareNames(a.name, b.name));
  for (const f of sortedFiles) {
    out.push({ kind: 'file', name: f.name, path: f.path, entry: f.entry });
  }

  return out;
}

export function buildPathTree<T extends { path: string }>(entries: T[]): TreeNode<T>[] {
  const root = emptyDir<T>();

  for (const entry of entries) {
    const segments = entry.path.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) continue;

    const fileName = segments[segments.length - 1];
    let cursor = root;
    for (const seg of segments.slice(0, -1)) {
      let next = cursor.dirs.get(seg);
      if (!next) { next = emptyDir<T>(); cursor.dirs.set(seg, next); }
      cursor = next;
    }
    cursor.files.push({ name: fileName, path: entry.path, entry });
  }

  return materialize(root, '');
}

/**
 * Case-insensitive substring match over the whole path.
 *
 * Substring, not regex: a user typing `api.ts` means those characters, and
 * treating `.` as "any character" would quietly widen the match.
 */
export function filterPaths<T extends { path: string }>(entries: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...entries];
  return entries.filter((e) => e.path.toLowerCase().includes(q));
}
