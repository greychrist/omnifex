export interface TreeFileNode<T> {
  kind: 'file';
  name: string;
  path: string;
  entry: T;
}

export interface TreeDirNode<T> {
  kind: 'dir';
  name: string;
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

    // A lone FILE does not collapse: `src/top.ts` must still show `src` as a directory to fold.
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

export function filterPaths<T extends { path: string }>(entries: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...entries];
  return entries.filter((e) => e.path.toLowerCase().includes(q));
}
