import React from "react";
import type { AgentMessage } from "@/lib/api";
import { AgentMessageItem } from "@/components/codex/items/AgentMessage";
import { AgentReasoningItem } from "@/components/codex/items/AgentReasoning";
import { ExecCommandItem } from "@/components/codex/items/ExecCommand";
import { ApplyPatchItem } from "@/components/codex/items/ApplyPatch";
import { WebSearchItem } from "@/components/codex/items/WebSearch";
import { McpToolCallItem } from "@/components/codex/items/McpToolCall";
import { CodexItemFallback } from "@/components/codex/items/CodexItemFallback";
import { SessionGutter, InspectorGutterButton, type InspectorGutterButtonProps } from '@/components/SessionGutter';

export interface CodexTranscriptProps extends InspectorGutterButtonProps {
  messages: AgentMessage[];
  tabId: string;
}

type ItemComponent = React.ComponentType<{ message: AgentMessage }>;

const HIDDEN_METHODS = new Set<string>(["task_started", "task_complete"]);

const ITEM_COMPONENTS: Record<string, ItemComponent> = {
  agent_message: AgentMessageItem,
  agent_reasoning: AgentReasoningItem,
  "item.exec_command": ExecCommandItem,
  "item.apply_patch": ApplyPatchItem,
  "item.web_search": WebSearchItem,
  "item.mcp_tool_call": McpToolCallItem,
};

// Null for non-Codex payloads: the same channel also carries Claude stream-json.
function getMethod(msg: AgentMessage): string | null {
  const payload = msg.payload;
  if (!payload || typeof payload !== "object") return null;
  const method = (payload as { method?: unknown }).method;
  return typeof method === "string" ? method : null;
}

export function CodexTranscript({ messages, tabId: _tabId, onOpenInspector, inspectorOpen }: CodexTranscriptProps): React.ReactElement {
  return (
    <div className="flex-1 min-h-0 px-10 py-2 bg-muted/30 relative">
      <SessionGutter
        top={<InspectorGutterButton onOpenInspector={onOpenInspector} inspectorOpen={inspectorOpen} />}
      >
        {null}
      </SessionGutter>
      <div className="h-full overflow-y-auto relative border border-border/50 rounded-lg bg-background">
        <div className="w-full px-4 pt-8 pb-4 space-y-4">
          {messages.map((msg, idx) => {
            const method = getMethod(msg);
            if (method == null) return null;
            if (HIDDEN_METHODS.has(method)) return null;
            const Component = ITEM_COMPONENTS[method] ?? CodexItemFallback;
            // Index keys are safe: Codex notifications are append-only and never reordered.
            return <Component key={idx} message={msg} />;
          })}
        </div>
      </div>
    </div>
  );
}
