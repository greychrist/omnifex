import type { AgentMessage } from "@/lib/api";

/**
 * Stub for Codex `item.mcp_tool_call` notifications.
 *
 * Task 21 fills this in with a server/tool/input/output card.
 */
export function McpToolCallItem({ message: _message }: { message: AgentMessage }): JSX.Element {
  return <div data-codex-item="item.mcp_tool_call">codex: item.mcp_tool_call</div>;
}
