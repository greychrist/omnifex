import { describe, it, expect } from 'vitest';
import { buildPathTree, filterPaths, type TreeDirNode, type TreeFileNode } from '@/lib/pathTree';

interface Entry { path: string; tag?: string }

const e = (path: string, tag?: string): Entry => ({ path, ...(tag ? { tag } : {}) });

const dirs = <T,>(nodes: ReturnType<typeof buildPathTree<T & { path: string }>>) =>
  nodes.filter((n): n is TreeDirNode<T & { path: string }> => n.kind === 'dir');

const files = <T,>(nodes: ReturnType<typeof buildPathTree<T & { path: string }>>) =>
  nodes.filter((n): n is TreeFileNode<T & { path: string }> => n.kind === 'file');

describe('buildPathTree', () => {
  describe('flat input', () => {
    it('returns root-level files for paths with no directory', () => {
      const tree = buildPathTree([e('a.ts'), e('b.ts')]);
      expect(tree.map((n) => n.kind)).toEqual(['file', 'file']);
      expect(files(tree).map((f) => f.name)).toEqual(['a.ts', 'b.ts']);
    });

    it('keeps the full path on a file node, not just its name', () => {
      const tree = buildPathTree([e('src/deep/a.ts')]);
      const dir = dirs(tree)[0];
      const file = dir.children.find((c) => c.kind === 'file') as TreeFileNode<Entry>;
      expect(file.name).toBe('a.ts');
      expect(file.path).toBe('src/deep/a.ts');
    });

    it('carries the original entry through so rows can show its status', () => {
      const tree = buildPathTree([e('a.ts', 'modified')]);
      expect(files(tree)[0].entry.tag).toBe('modified');
    });
  });

  describe('nesting', () => {
    it('groups files under their directory', () => {
      const tree = buildPathTree([e('src/a.ts'), e('src/b.ts')]);
      expect(tree).toHaveLength(1);
      const src = dirs(tree)[0];
      expect(src.name).toBe('src');
      expect(src.children.map((c) => c.name)).toEqual(['a.ts', 'b.ts']);
    });

    it('nests directories to arbitrary depth', () => {
      const tree = buildPathTree([e('a/b/c/d.ts')]);
      const a = dirs(tree)[0];
      expect(a.name).toBe('a/b/c');
      expect(a.children[0].name).toBe('d.ts');
    });
  });

  describe('single-child chain collapsing', () => {
    // A tree that renders `aws-components` → `edge` → `terraform` as three
    // rows wastes three lines to convey one location.
    it('collapses a chain of directories that each hold only one directory', () => {
      const tree = buildPathTree([
        e('aws-components/edge/terraform/iam.tf'),
        e('aws-components/edge/terraform/vars.tf'),
      ]);
      expect(tree).toHaveLength(1);
      expect(tree[0].name).toBe('aws-components/edge/terraform');
    });

    it('gives the collapsed node the full path of its deepest segment', () => {
      const tree = buildPathTree([e('a/b/c/d.ts')]);
      expect(dirs(tree)[0].path).toBe('a/b/c');
    });

    it('does not collapse a directory that holds two children', () => {
      const tree = buildPathTree([e('src/a/x.ts'), e('src/b/y.ts')]);
      expect(tree).toHaveLength(1);
      expect(tree[0].name).toBe('src');
      expect(dirs(tree)[0].children.map((c) => c.name)).toEqual(['a', 'b']);
    });

    it('does not collapse a directory holding one directory AND one file', () => {
      const tree = buildPathTree([e('src/a/x.ts'), e('src/top.ts')]);
      expect(tree[0].name).toBe('src');
      expect(dirs(tree)[0].children.map((c) => c.name)).toEqual(['a', 'top.ts']);
    });
  });

  describe('ordering', () => {
    it('sorts directories before files at the same level', () => {
      const tree = buildPathTree([e('zzz.ts'), e('aaa/b.ts')]);
      expect(tree.map((n) => n.kind)).toEqual(['dir', 'file']);
    });

    it('sorts directories alphabetically', () => {
      const tree = buildPathTree([e('b/x.ts'), e('a/y.ts')]);
      expect(tree.map((n) => n.name)).toEqual(['a', 'b']);
    });

    it('sorts files alphabetically', () => {
      const tree = buildPathTree([e('c.ts'), e('a.ts'), e('b.ts')]);
      expect(tree.map((n) => n.name)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    });

    it('sorts case-insensitively so Z does not precede a', () => {
      const tree = buildPathTree([e('apple.ts'), e('Zebra.ts'), e('Banana.ts')]);
      expect(tree.map((n) => n.name)).toEqual(['apple.ts', 'Banana.ts', 'Zebra.ts']);
    });
  });

  describe('degenerate input', () => {
    it('returns [] for no files', () => {
      expect(buildPathTree([])).toEqual([]);
    });

    it('ignores an empty path rather than creating a nameless node', () => {
      expect(buildPathTree([e(''), e('a.ts')]).map((n) => n.name)).toEqual(['a.ts']);
    });
  });
});

describe('filterPaths', () => {
  const entries = [e('src/components/Button.tsx'), e('src/lib/api.ts'), e('README.md')];

  it('returns everything for an empty query', () => {
    expect(filterPaths(entries, '')).toHaveLength(3);
  });

  it('returns everything for a whitespace-only query', () => {
    expect(filterPaths(entries, '   ')).toHaveLength(3);
  });

  it('matches anywhere in the path, not just the file name', () => {
    expect(filterPaths(entries, 'components').map((f) => f.path)).toEqual([
      'src/components/Button.tsx',
    ]);
  });

  it('matches case-insensitively', () => {
    expect(filterPaths(entries, 'BUTTON').map((f) => f.path)).toEqual([
      'src/components/Button.tsx',
    ]);
  });

  it('returns [] when nothing matches', () => {
    expect(filterPaths(entries, 'nothing-here')).toEqual([]);
  });

  it('treats the query as literal text, not a regular expression', () => {
    // A user typing `api.ts` should not have `.` behave as "any character".
    expect(filterPaths(entries, 'apiXts')).toEqual([]);
  });
});
