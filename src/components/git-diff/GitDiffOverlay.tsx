import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, GitCompare, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, type GitChangedFile } from "@/lib/api";
import { parseUnifiedDiff, type DiffFile } from "@/lib/unifiedDiff";
import { languageForPath } from "@/lib/diffLanguage";
import { DiffFileTree } from "./DiffFileTree";
import { SplitDiffView } from "./SplitDiffView";

/**
 * Full-screen working-tree diff: file navigator on the left, side-by-side
 * patch on the right.
 *
 * Owns all fetching for the feature. The file list is read once per
 * `refreshToken`, and a patch is read per selected file — never on a timer.
 * The per-tab git watcher already pushes change notifications; the caller
 * turns those into a `refreshToken` bump rather than this component polling.
 *
 * Context expansion is per-file and whole-file: clicking a gap re-reads the
 * same patch at a wider `-U`. It is NOT per-gap, because git has no way to
 * widen one hunk in isolation — expanding a gap in the middle of a file
 * necessarily widens the others too. The ladder stops at a value large enough
 * to mean "the whole file", which is how "expand all" is expressed without a
 * second code path.
 */

/** Context widths the expand control walks through, in unchanged lines. */
const CONTEXT_LADDER = [3, 25, 100, 1_000_000] as const;

/** Body-line cap when parsing, so one enormous file cannot hang the parse. */
const PARSE_LINE_BUDGET = 60_000;

export interface GitDiffOverlayProps {
  projectPath: string;
  onClose: () => void;
  /** Bump to re-read the file list. */
  refreshToken?: number;
  className?: string;
}

type Load<T> =
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "error"; message: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const GitDiffOverlay: React.FC<GitDiffOverlayProps> = ({
  projectPath,
  onClose,
  refreshToken = 0,
  className,
}) => {
  const [files, setFiles] = useState<Load<GitChangedFile[]>>({ state: "loading" });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [patch, setPatch] = useState<Load<string>>({ state: "loading" });
  const [contextIndex, setContextIndex] = useState(0);

  // Escape closes. Captured on window so it works regardless of what inside
  // the overlay holds focus.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, [onClose]);

  // ── File list ────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setFiles({ state: "loading" });
    api.listGitChangedFiles(projectPath)
      .then((value) => {
        if (cancelled) return;
        setFiles({ state: "ready", value });
        // Open the first file so the right-hand pane is never blank. Keep the
        // current selection across a refresh if it still exists — a refresh
        // fires on every save, and yanking the reader back to file one would
        // make the overlay unusable while work is in flight.
        setSelectedPath((current) => {
          if (current && value.some((f) => f.path === current)) return current;
          return value.length > 0 ? value[0].path : null;
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFiles({ state: "error", message: errorMessage(err) });
      });
    return () => { cancelled = true; };
  }, [projectPath, refreshToken]);

  // ── Patch for the selected file ──────────────────────────────────────────
  useEffect(() => {
    if (!selectedPath) { setPatch({ state: "ready", value: "" }); return; }
    let cancelled = false;
    setPatch({ state: "loading" });
    api.getGitFileDiff(projectPath, selectedPath, CONTEXT_LADDER[contextIndex])
      .then((value) => { if (!cancelled) setPatch({ state: "ready", value }); })
      .catch((err: unknown) => {
        if (!cancelled) setPatch({ state: "error", message: errorMessage(err) });
      });
    return () => { cancelled = true; };
  }, [projectPath, selectedPath, contextIndex, refreshToken]);

  // A new file starts at the narrowest context. Without this, opening a small
  // file after expanding a large one would render the whole thing.
  const previousPath = useRef(selectedPath);
  useEffect(() => {
    if (previousPath.current !== selectedPath) {
      previousPath.current = selectedPath;
      setContextIndex(0);
    }
  }, [selectedPath]);

  const onSelect = useCallback((path: string) => {
    setSelectedPath(path);
    setContextIndex(0);
  }, []);

  const parsed: DiffFile | null = useMemo(() => {
    if (patch.state !== "ready" || patch.value === "") return null;
    const result = parseUnifiedDiff(patch.value, { maxLines: PARSE_LINE_BUDGET });
    return result?.files[0] ?? null;
  }, [patch]);

  const canExpandContext = contextIndex < CONTEXT_LADDER.length - 1;
  const onExpandContext = useCallback(() => {
    setContextIndex((i) => Math.min(i + 1, CONTEXT_LADDER.length - 1));
  }, []);

  const fileList = files.state === "ready" ? files.value : [];

  return (
    <div
      className={cn(
        "absolute inset-0 z-30 flex flex-col bg-background",
        className,
      )}
    >
      <div className="flex flex-none items-center gap-2 border-b px-3 py-2">
        <GitCompare className="h-4 w-4 flex-none text-muted-foreground" />
        <span className="text-[13px] font-medium">Working tree changes</span>
        {files.state === "ready" && (
          <span className="text-[11px] text-muted-foreground">
            {fileList.length} {fileList.length === 1 ? "file" : "files"}
          </span>
        )}
        <button
          type="button"
          aria-label="Close diff viewer"
          onClick={onClose}
          className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-[280px] flex-none border-r">
          {files.state === "error" ? (
            <p className="px-3 py-3 text-[12px] text-red-400">
              Could not read the working tree: {files.message}
            </p>
          ) : (
            <DiffFileTree
              files={fileList}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {selectedPath && (
            <div className="flex flex-none items-center gap-3 border-b px-3 py-1.5">
              <span
                data-testid="diff-header-path"
                className="truncate font-mono text-[12px]"
              >
                {selectedPath}
              </span>
              {parsed && (
                <span className="ml-auto flex flex-none items-center gap-2 font-mono text-[11px]">
                  <span className="text-emerald-400">+{parsed.added}</span>
                  <span className="text-red-400">−{parsed.removed}</span>
                </span>
              )}
            </div>
          )}

          <div className="min-h-0 flex-1">
            {patch.state === "loading" ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : patch.state === "error" ? (
              <p className="px-3 py-3 text-[12px] text-red-400">
                Could not read the diff: {patch.message}
              </p>
            ) : parsed ? (
              <SplitDiffView
                file={parsed}
                language={languageForPath(selectedPath ?? "")}
                canExpandContext={canExpandContext}
                onExpandContext={onExpandContext}
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <p className="text-[12px] text-muted-foreground">
                  {selectedPath ? "No diff to show for this file." : "Select a file."}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
