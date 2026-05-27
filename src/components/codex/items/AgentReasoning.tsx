import type { AgentMessage } from "@/lib/api";

/**
 * Stub for Codex `agent_reasoning` notifications.
 *
 * Task 20 fills this in with a collapsible "Thinking…" block. For Task 19
 * the stub only proves the dispatch table routes to this component.
 */
export function AgentReasoningItem({ message: _message }: { message: AgentMessage }): JSX.Element {
  return <div data-codex-item="agent_reasoning">codex: agent_reasoning</div>;
}
