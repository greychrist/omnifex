import type { AgentMessage } from "@/lib/api";

/**
 * Stub for Codex `item.web_search` notifications.
 *
 * Task 21 fills this in with a search-query + results-list card.
 */
export function WebSearchItem({ message: _message }: { message: AgentMessage }): JSX.Element {
  return <div data-codex-item="item.web_search">codex: item.web_search</div>;
}
