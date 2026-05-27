import { useState } from "react";
import { ChevronRight, FileEdit } from "lucide-react";
import { cn } from "@/lib/utils";
import { DiffViewer } from "@/components/shared/DiffViewer";
import { getLanguage } from "@/components/claude/tools/shared";

/**
 * Normalized per-file change extracted from a Codex `applyPatchApproval`
 * approval payload. Mirrors the shape `ApplyPatchItem` uses for the post-
 * apply notification so a transcript that interleaves the approval card
 * and the apply notification reads as a single visual flow.
 */
interface FileChange {
  path: string;
  before: string;
  after: string;
}

interface PatchFields {
  reason: string;
  files: FileChange[];
}

/**
 * Coerce an unknown side of a per-file change into a string. Codex builds
 * have shipped `before`/`after` as either a plain string or an object with
 * a `lines: string[]` array — match `ApplyPatchItem.coerceSide` exactly so
 * the diff viewer sees the same content both before and after approval.
 */
function coerceSide(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const lines = (value as { lines?: unknown }).lines;
    if (Array.isArray(lines)) {
      return lines
        .map((l) => (typeof l === "string" ? l : ""))
        .join("\n");
    }
  }
  return "";
}

/**
 * Extract `fileChanges` + `reason` from an `applyPatchApproval` approval
 * payload.
 *
 * Wire shape (Codex JSON-RPC server-request `applyPatchApproval`):
 *
 *   { conversationId, callId, fileChanges, reason? }
 *
 * `fileChanges` is either an object map (`{ [path]: { before?, after? } }`)
 * or an array (`Array<{ path, before?, after? }>`). Anything else yields an
 * empty file list — a Codex protocol shape change shouldn't crash the
 * dialog.
 */
function extractPatch(payload: unknown): PatchFields {
  const empty: PatchFields = { reason: "", files: [] };
  if (!payload || typeof payload !== "object") return empty;
  const p = payload as { fileChanges?: unknown; reason?: unknown };
  const reason = typeof p.reason === "string" ? p.reason : "";

  const files: FileChange[] = [];
  const fc = p.fileChanges;
  if (Array.isArray(fc)) {
    for (const entry of fc) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { path?: unknown; before?: unknown; after?: unknown };
      const path = typeof e.path === "string" ? e.path : "";
      if (!path) continue;
      files.push({
        path,
        before: coerceSide(e.before),
        after: coerceSide(e.after),
      });
    }
  } else if (fc && typeof fc === "object") {
    for (const [path, entry] of Object.entries(fc as Record<string, unknown>)) {
      const e = (entry ?? {}) as { before?: unknown; after?: unknown };
      files.push({
        path,
        before: coerceSide(e.before),
        after: coerceSide(e.after),
      });
    }
  }

  return { reason, files };
}

interface FileBlockProps {
  change: FileChange;
  /** Default-expanded? Caller decides based on total file count. */
  defaultOpen: boolean;
}

function FileBlock({ change, defaultOpen }: FileBlockProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const language = getLanguage(change.path);
  return (
    <div className="rounded-md border bg-background overflow-hidden">
      <button
        type="button"
        onClick={() => { setIsOpen((v) => !v); }}
        aria-expanded={isOpen}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-muted/50 transition-colors text-left"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            isOpen && "rotate-90",
          )}
        />
        <FileEdit className="h-3.5 w-3.5 shrink-0 text-primary" />
        <code className="text-xs font-mono truncate flex-1">{change.path}</code>
      </button>
      {isOpen && (
        <div className="px-3 pb-3">
          <DiffViewer
            oldText={change.before}
            newText={change.after}
            language={language}
          />
        </div>
      )}
    </div>
  );
}

interface CodexPatchPreviewProps {
  /**
   * Raw `applyPatchApproval` JSON-RPC params as Codex emitted them. The
   * component shape-probes defensively — same pattern as
   * `ApplyPatchItem.extractPatch` — so a build that ships an unexpected
   * shape renders an empty state rather than crashing.
   */
  payload: unknown;
}

/**
 * Renders a Codex patch-approval preview as an N-files header with
 * per-file collapsible diffs. Mirrors `ApplyPatchItem` (the post-apply
 * notification widget) so the approval and the applied patch read as a
 * continuous visual flow.
 *
 * Default-collapse heuristic: files expand inline when N ≤ 3 (typical
 * single-file rewrite or small refactor) and collapse when larger so a
 * sweeping patch doesn't blow out the dialog on arrival.
 */
export function CodexPatchPreview({ payload }: CodexPatchPreviewProps): JSX.Element {
  const { reason, files } = extractPatch(payload);
  const defaultOpen = files.length <= 3;

  return (
    <div
      data-codex-permission="patch"
      className="rounded-lg border bg-background overflow-hidden"
    >
      <div className="px-4 py-2 bg-muted/50 flex items-center gap-2 border-b">
        <FileEdit className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium">
          Codex wants to apply a patch ({files.length} file
          {files.length === 1 ? "" : "s"})
        </span>
        {reason && (
          <span className="text-xs text-muted-foreground truncate ml-2">
            — {reason}
          </span>
        )}
      </div>
      {files.length === 0 ? (
        <div className="px-4 py-3 text-xs text-muted-foreground italic">
          (no file changes)
        </div>
      ) : (
        <div className="p-3 space-y-2">
          {files.map((change) => (
            <FileBlock
              key={change.path}
              change={change}
              defaultOpen={defaultOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}
