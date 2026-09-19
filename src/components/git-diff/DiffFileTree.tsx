import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Folder, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildPathTree, filterPaths, type TreeNode } from "@/lib/pathTree";
import type { GitChangedFile, GitChangedFileStatus } from "@/lib/api";

/**
 * Left-hand navigator for the diff overlay: the changed files as a foldable
 * tree, with a filter box.
 *
 * Owns the filter rather than taking filtered files, so the overlay does not
 * have to thread input state through itself just to pass it back down. The
 * tree is the only thing that cares.
 *
 * Fold state is keyed by directory path and defaults to open. A changed-file
 * tree is small by construction — it holds only what differs from HEAD — so
 * opening everything is the useful default, unlike a whole-repo browser.
 */

export interface DiffFileTreeProps {
  files: GitChangedFile[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  className?: string;
}

const STATUS_GLYPH: Record<GitChangedFileStatus, { char: string; className: string }> = {
  modified: { char: "±", className: "text-amber-400" },
  added: { char: "+", className: "text-emerald-400" },
  untracked: { char: "+", className: "text-emerald-400" },
  deleted: { char: "−", className: "text-red-400" },
  renamed: { char: "→", className: "text-sky-400" },
};

function statusLabel(file: GitChangedFile): string {
  const staged = file.staged ? ", staged" : "";
  return `${file.status}${staged}`;
}

interface RowProps {
  node: TreeNode<GitChangedFile>;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  collapsed: Set<string>;
  toggle: (path: string) => void;
}

const Row: React.FC<RowProps> = ({ node, depth, selectedPath, onSelect, collapsed, toggle }) => {
  // 12px per level, plus room for the chevron column so file and directory
  // labels at the same depth line up.
  const indent = { paddingLeft: `${depth * 12 + 6}px` };

  if (node.kind === "dir") {
    const isOpen = !collapsed.has(node.path);
    return (
      <>
        <div
          role="treeitem"
          aria-expanded={isOpen}
          tabIndex={-1}
          onClick={() => { toggle(node.path); }}
          style={indent}
          className="flex items-center gap-1 py-[3px] pr-2 cursor-pointer select-none rounded-sm hover:bg-accent/40"
        >
          {isOpen
            ? <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
            : <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />}
          <Folder className="h-3.5 w-3.5 flex-none text-muted-foreground/80" />
          <span className="truncate text-[12px] text-foreground/90">{node.name}</span>
        </div>
        {isOpen && node.children.map((child) => (
          <Row
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
            collapsed={collapsed}
            toggle={toggle}
          />
        ))}
      </>
    );
  }

  const selected = selectedPath === node.path;
  const glyph = STATUS_GLYPH[node.entry.status];

  return (
    <div
      role="treeitem"
      aria-selected={selected}
      tabIndex={-1}
      onClick={() => { onSelect(node.path); }}
      style={indent}
      className={cn(
        "flex items-center gap-1.5 py-[3px] pr-2 cursor-pointer select-none rounded-sm",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
      )}
    >
      <span className="w-3.5 flex-none" />
      <span
        aria-label={statusLabel(node.entry)}
        title={statusLabel(node.entry)}
        className={cn("flex-none font-mono text-[12px] leading-none", glyph.className)}
      >
        {glyph.char}
      </span>
      <span className="truncate text-[12px]">{node.name}</span>
      {node.entry.staged && (
        <span className="ml-auto flex-none text-[9px] uppercase tracking-wide text-muted-foreground/70">
          staged
        </span>
      )}
    </div>
  );
};

export const DiffFileTree: React.FC<DiffFileTreeProps> = ({
  files,
  selectedPath,
  onSelect,
  className,
}) => {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const visible = useMemo(() => filterPaths(files, query), [files, query]);
  const tree = useMemo(() => buildPathTree(visible), [visible]);

  const toggle = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex-none p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); }}
            placeholder="Filter files…"
            spellCheck={false}
            className="w-full rounded-md border bg-background/60 py-1.5 pl-7 pr-2 text-[12px] outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      <div role="tree" className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {files.length === 0 ? (
          <p className="px-2 py-3 text-[12px] text-muted-foreground">
            No changes in the working tree.
          </p>
        ) : visible.length === 0 ? (
          <p className="px-2 py-3 text-[12px] text-muted-foreground">
            No files match “{query.trim()}”.
          </p>
        ) : (
          tree.map((node) => (
            <Row
              key={node.path}
              node={node}
              depth={0}
              selectedPath={selectedPath}
              onSelect={onSelect}
              collapsed={collapsed}
              toggle={toggle}
            />
          ))
        )}
      </div>
    </div>
  );
};
