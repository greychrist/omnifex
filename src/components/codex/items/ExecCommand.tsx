import type { AgentMessage } from "@/lib/api";

/**
 * Stub for Codex `item.exec_command` notifications.
 *
 * Task 21 fills this in with a shell-preview card (command + exit code +
 * trimmed stdout/stderr).
 */
export function ExecCommandItem({ message: _message }: { message: AgentMessage }): JSX.Element {
  return <div data-codex-item="item.exec_command">codex: item.exec_command</div>;
}
