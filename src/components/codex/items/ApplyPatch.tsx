import { useState } from "react";
import { ChevronRight, FileEdit } from "lucide-react";
import { cn } from "@/lib/utils";
import { DiffViewer } from "@/components/shared/DiffViewer";
import { getLanguage } from "@/components/claude/tools/shared";
import type { AgentMessage } from "@/lib/api";

/**
 * Normalized per-file change extracted from a Codex `item.apply_patch`
 * payload. `before`/`after` are always plain strings by the time we hand
 * them to `DiffViewer` — see `extractFileChanges` for the shape probing.
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
 * have shipped `before`/`after` as either:
 *   - a plain string ("..."), or
 *   - an object with a `lines: string[]` array.
 *
 * Anything else (null, number, object without lines) renders as empty so
 * the diff viewer still gets a usable comparison surface.
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
 * Extracts fileChanges + reason from an `item.apply_patch` payload.
 *
 * Wire shape (Codex; varies):
 *   { method: "item.apply_patch", params: {
 *       fileChanges: { [path]: { before?, after? } } | Array<{ path, before?, after? }>,
 *       reason?: string,
 *       callId?: string,
 *   } }
 *
 * Defensive: missing/malformed params yield an empty file list rather
 * than throwing — a Codex protocol shape change shouldn't crash the
 * transcript.
 */
function extractPatch(payload: unknown): PatchFields {
  const empty: PatchFields = { reason: "", files: [] };
  if (!payload || typeof payload !== "object") return empty;
  const params = (payload as { params?: unknown }).params;
  if (!params || typeof params !== "object") return empty;
  const p = params as { fileChanges?: unknown; reason?: unknown };
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
          className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")}
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

/**
 * Renders a Codex `item.apply_patch` notification as an N-files header
 * with per-file collapsible diffs. Each file uses the shared `DiffViewer`
 * (lifted out of `EditWidget` in Task 18) so Codex patches and Claude
 * `Edit` tool calls share identical diff visuals.
 *
 * Default-collapse heuristic: files expand inline when N ≤ 3 (typical
 * single-file rewrite or small multi-file refactor) and collapse when
 * larger so a sweeping patch doesn't blow out the transcript on arrival.
 */
export function ApplyPatchItem({ message }: { message: AgentMessage }): JSX.Element {
  const { reason, files } = extractPatch(message.payload);
  const defaultOpen = files.length <= 3;

  return (
    <div
      data-codex-item="item.apply_patch"
      className="rounded-lg border bg-background overflow-hidden"
    >
      <div className="px-4 py-2 bg-muted/50 flex items-center gap-2 border-b">
        <FileEdit className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium">
          Applied patch ({files.length} file{files.length === 1 ? "" : "s"})
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
