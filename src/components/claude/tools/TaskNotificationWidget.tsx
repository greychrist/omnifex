import React from "react";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { parseTaskNotification } from "@/lib/taskNotification";
import { formatDurationMs } from "@/lib/duration";

/**
 * Renders a `<task-notification>` payload as prose instead of tag soup.
 *
 * These arrive as a flat pseudo-XML envelope in a user-role text block, so
 * without this they rendered as a paragraph of angle brackets — the markup
 * reflowed by the markdown renderer into one unreadable line.
 *
 * The summary is deliberately NOT repeated here: it is the collapsed header
 * of the frame that wraps this, which stays visible while the body is open.
 */
export const TaskNotificationWidget: React.FC<{ text: string }> = ({ text }) => {
  const n = parseTaskNotification(text);
  if (!n) {
    return <div className="text-sm text-foreground/90 whitespace-pre-wrap break-words">{text}</div>;
  }

  const stats: string[] = [];
  if (n.usage?.tokens !== undefined) stats.push(`${n.usage.tokens.toLocaleString()} tokens`);
  if (n.usage?.toolUses !== undefined) {
    stats.push(`${n.usage.toolUses} tool use${n.usage.toolUses === 1 ? "" : "s"}`);
  }
  if (n.usage?.durationMs !== undefined) stats.push(formatDurationMs(n.usage.durationMs));

  // A returned result and a monitor's firing text are the same slot: the one
  // piece of body text the notification actually carries.
  const body = n.result ?? n.event;

  return (
    <div className="space-y-2 text-sm">
      {n.status && (
        <div className="flex items-center gap-1.5">
          {n.status === "completed"
            ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
            : <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />}
          <span className={n.status === "completed" ? "text-green-500" : "text-red-500"}>
            {n.status === "completed" ? "Completed" : "Failed"}
          </span>
        </div>
      )}

      {body && (
        <div className="text-foreground/90 whitespace-pre-wrap break-words">{body}</div>
      )}

      {stats.length > 0 && (
        <div className="text-xs text-muted-foreground font-mono">{stats.join(" · ")}</div>
      )}

      {(n.taskId || n.outputFile) && (
        <dl className="text-xs text-muted-foreground space-y-0.5">
          {n.taskId && (
            <div className="flex gap-2">
              <dt className="shrink-0">Task</dt>
              <dd className="font-mono break-all">{n.taskId}</dd>
            </div>
          )}
          {n.outputFile && (
            <div className="flex gap-2">
              <dt className="shrink-0">Output</dt>
              <dd className="font-mono break-all">{n.outputFile}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
};
