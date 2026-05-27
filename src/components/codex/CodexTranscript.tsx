import React from "react";
import type { AgentMessage } from "@/lib/api";
import { AgentMessageItem } from "@/components/codex/items/AgentMessage";
import { AgentReasoningItem } from "@/components/codex/items/AgentReasoning";
import { ExecCommandItem } from "@/components/codex/items/ExecCommand";
import { ApplyPatchItem } from "@/components/codex/items/ApplyPatch";
import { WebSearchItem } from "@/components/codex/items/WebSearch";
import { McpToolCallItem } from "@/components/codex/items/McpToolCall";
import { CodexItemFallback } from "@/components/codex/items/CodexItemFallback";

export interface CodexTranscriptProps {
  /** All Codex notifications for this tab, in arrival order. */
  messages: AgentMessage[];
  /** Tab id forwarded to per-item components that may need it later. */
  tabId: string;
}

type ItemComponent = React.ComponentType<{ message: AgentMessage }>;

/**
 * Methods that do NOT render as transcript cards. `task_started` /
 * `task_complete` are status-only signals consumed by the session shell's
 * spinner / activity bar — surfacing them inline would create empty
 * pseudo-cards on every turn boundary.
 */
const HIDDEN_METHODS = new Set<string>(["task_started", "task_complete"]);

/**
 * Dispatch table for Codex notification methods. Methods not listed here
 * (and not in `HIDDEN_METHODS`) fall through to `CodexItemFallback` so
 * unfamiliar payloads remain visible during development.
 *
 * Task 19 ships stub item components; Tasks 20–21 fill in the real
 * renderers without touching this table.
 */
const ITEM_COMPONENTS: Record<string, ItemComponent> = {
  agent_message: AgentMessageItem,
  agent_reasoning: AgentReasoningItem,
  "item.exec_command": ExecCommandItem,
  "item.apply_patch": ApplyPatchItem,
  "item.web_search": WebSearchItem,
  "item.mcp_tool_call": McpToolCallItem,
};

/**
 * Extract the `method` discriminator off a Codex notification envelope.
 * Returns `null` when the payload isn't a Codex-shaped notification
 * (defensive — same channel also carries Claude stream-json today).
 */
function getMethod(msg: AgentMessage): string | null {
  const payload = msg.payload;
  if (!payload || typeof payload !== "object") return null;
  const method = (payload as { method?: unknown }).method;
  return typeof method === "string" ? method : null;
}

/**
 * Codex transcript — peer to `ClaudeTranscript`. Renders a flat list of
 * Codex notifications, dispatching each on `payload.method` to a small
 * per-item component under `src/components/codex/items/`.
 *
 * Intentionally minimal for Task 19: no scroll-to-bottom logic, no find
 * bar, no inflight bubble. Codex transcripts may pick up similar UX in a
 * follow-up; for now the shell only needs to prove the dispatch table.
 */
export function CodexTranscript({ messages, tabId: _tabId }: CodexTranscriptProps): React.ReactElement {
  return (
    <div className="flex-1 min-h-0 px-10 py-2 bg-muted/30 relative">
      <div className="h-full overflow-y-auto relative border border-border/50 rounded-lg bg-background">
        <div className="w-full px-4 pt-8 pb-4 space-y-4">
          {messages.map((msg, idx) => {
            const method = getMethod(msg);
            if (method == null) return null;
            if (HIDDEN_METHODS.has(method)) return null;
            const Component = ITEM_COMPONENTS[method] ?? CodexItemFallback;
            // Index-based keys are fine here: Codex notifications are
            // append-only and never reordered or merged the way Claude
            // stream events are.
            return <Component key={idx} message={msg} />;
          })}
        </div>
      </div>
    </div>
  );
}
