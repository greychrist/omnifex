import type { AgentMessage } from "@/lib/api";

/**
 * Stub for Codex `agent_message` notifications.
 *
 * Task 20 will replace the body with the real renderer (markdown text +
 * shared message-card chrome). For now we only need the dispatch wiring,
 * so this prints the method name so the CodexTranscript shell test can
 * assert the right item type mounted.
 */
export function AgentMessageItem({ message: _message }: { message: AgentMessage }): JSX.Element {
  return <div data-codex-item="agent_message">codex: agent_message</div>;
}
