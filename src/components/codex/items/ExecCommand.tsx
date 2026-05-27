import { useState } from "react";
import { Terminal, ChevronRight, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentMessage } from "@/lib/api";

/**
 * Extracts the displayable fields from an `item.exec_command` notification.
 *
 * Wire shape (from Codex; varies subtly across CLI builds):
 *   { method: "item.exec_command", params: {
 *       command: string,
 *       cwd?: string,
 *       stdout?: string,
 *       stderr?: string,
 *       status?: "running" | "completed" | "failed",
 *       exitCode?: number,
 *   } }
 *
 * Defensive: returns empty strings + status="running" when params are
 * missing or malformed so the widget renders a coherent (if empty) card
 * rather than crashing the transcript.
 */
interface ExecFields {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  status: "running" | "completed" | "failed";
}

function extractExec(payload: unknown): ExecFields {
  const empty: ExecFields = {
    command: "",
    cwd: "",
    stdout: "",
    stderr: "",
    status: "running",
  };
  if (!payload || typeof payload !== "object") return empty;
  const params = (payload as { params?: unknown }).params;
  if (!params || typeof params !== "object") return empty;
  const p = params as {
    command?: unknown;
    cwd?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    status?: unknown;
  };
  const statusRaw = typeof p.status === "string" ? p.status : "";
  const status: ExecFields["status"] =
    statusRaw === "completed" || statusRaw === "failed" ? statusRaw : "running";
  return {
    command: typeof p.command === "string" ? p.command : "",
    cwd: typeof p.cwd === "string" ? p.cwd : "",
    stdout: typeof p.stdout === "string" ? p.stdout : "",
    stderr: typeof p.stderr === "string" ? p.stderr : "",
    status,
  };
}

/** Length above which stdout/stderr collapses behind a toggle. */
const INLINE_LIMIT = 200;

interface StatusBadgeProps {
  status: ExecFields["status"];
}

function StatusBadge({ status }: StatusBadgeProps): JSX.Element {
  const styles: Record<ExecFields["status"], string> = {
    running: "bg-blue-500/10 text-blue-500 border-blue-500/20",
    completed: "bg-green-500/10 text-green-500 border-green-500/20",
    failed: "bg-red-500/10 text-red-500 border-red-500/20",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        styles[status],
      )}
    >
      {status}
    </span>
  );
}

interface StreamProps {
  label: string;
  text: string;
  tone: "stdout" | "stderr";
}

function StreamBlock({ label, text, tone }: StreamProps): JSX.Element | null {
  const [isOpen, setIsOpen] = useState(text.length <= INLINE_LIMIT);
  if (!text) return null;
  const isLong = text.length > INLINE_LIMIT;
  const colorClass =
    tone === "stderr" ? "text-red-400" : "text-green-300";
  const borderClass =
    tone === "stderr"
      ? "border-red-500/20 bg-red-500/5"
      : "border-green-500/20 bg-green-500/5";

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => { setIsOpen((v) => !v); }}
        aria-expanded={isOpen}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRight
          className={cn("h-3 w-3 transition-transform", isOpen && "rotate-90")}
        />
        <span>{label}</span>
        {isLong && (
          <span className="text-muted-foreground/60">
            ({text.length} chars)
          </span>
        )}
      </button>
      {isOpen && (
        <pre
          className={cn(
            "p-3 rounded-md border text-xs font-mono whitespace-pre-wrap overflow-x-auto",
            borderClass,
            colorClass,
          )}
        >
          {text}
        </pre>
      )}
    </div>
  );
}

/**
 * Renders a Codex `item.exec_command` notification as a shell-preview card.
 *
 * Visually echoes Claude's `BashWidget` — same Terminal icon, same muted
 * header, same `$` prefix on the command line — so a transcript that
 * interleaves Claude Bash tool calls with Codex exec items reads as a
 * single coherent shell stream.
 */
export function ExecCommandItem({ message }: { message: AgentMessage }): JSX.Element {
  const { command, cwd, stdout, stderr, status } = extractExec(message.payload);
  const [copied, setCopied] = useState(false);

  const handleCopy = (): void => {
    if (!command) return;
    const writer = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (!writer) return;
    writer(command)
      .then(() => {
        setCopied(true);
        setTimeout(() => { setCopied(false); }, 1500);
      })
      .catch((err: unknown) => {
        console.error("[codex-exec:copy]", err);
      });
  };

  return (
    <div
      data-codex-item="item.exec_command"
      className="rounded-lg border bg-background overflow-hidden"
    >
      <div className="px-4 py-2 bg-muted/50 flex items-center gap-2 border-b">
        <Terminal className="h-3.5 w-3.5 text-green-500" />
        <span className="text-xs font-mono text-muted-foreground">Terminal</span>
        <div className="ml-auto flex items-center gap-2">
          <StatusBadge status={status} />
        </div>
      </div>
      <div className="p-4 space-y-3">
        <div className="flex items-start gap-2">
          <code className="text-xs font-mono text-green-400 block flex-1 break-all">
            $ {command || <span className="text-muted-foreground italic">(empty command)</span>}
          </code>
          {command && (
            <button
              type="button"
              onClick={handleCopy}
              aria-label="Copy command"
              className="shrink-0 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
        {cwd && (
          <div className="text-xs text-muted-foreground font-mono truncate">
            cwd: {cwd}
          </div>
        )}
        <StreamBlock label="stdout" text={stdout} tone="stdout" />
        <StreamBlock label="stderr" text={stderr} tone="stderr" />
      </div>
    </div>
  );
}
