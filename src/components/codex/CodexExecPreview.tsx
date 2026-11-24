import { Terminal } from "lucide-react";
import type { JSX } from 'react';

interface ExecFields {
  command: string;
  cwd: string;
  reason: string;
}

function extractExec(payload: unknown): ExecFields {
  const empty: ExecFields = { command: "", cwd: "", reason: "" };
  if (!payload || typeof payload !== "object") return empty;
  const p = payload as { command?: unknown; cwd?: unknown; reason?: unknown };
  return {
    command: typeof p.command === "string" ? p.command : "",
    cwd: typeof p.cwd === "string" ? p.cwd : "",
    reason: typeof p.reason === "string" ? p.reason : "",
  };
}

interface CodexExecPreviewProps {
  payload: unknown;
}

export function CodexExecPreview({ payload }: CodexExecPreviewProps): JSX.Element {
  const { command, cwd, reason } = extractExec(payload);

  return (
    <div
      data-codex-permission="exec"
      className="rounded-lg border bg-background overflow-hidden"
    >
      <div className="px-4 py-2 bg-muted/50 flex items-center gap-2 border-b">
        <Terminal className="h-3.5 w-3.5 text-green-500" />
        <span className="text-xs font-mono text-muted-foreground">
          Codex wants to run a command
        </span>
      </div>
      <div className="p-4 space-y-3">
        <code className="text-xs font-mono text-green-400 block break-all">
          $ {command || (
            <span className="text-muted-foreground italic">(empty command)</span>
          )}
        </code>
        {cwd && (
          <div className="text-xs text-muted-foreground font-mono truncate">
            cwd: {cwd}
          </div>
        )}
        {reason && (
          <div className="text-xs text-muted-foreground">{reason}</div>
        )}
      </div>
    </div>
  );
}
