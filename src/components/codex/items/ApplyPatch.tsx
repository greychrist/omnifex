import type { AgentMessage } from "@/lib/api";

/**
 * Stub for Codex `item.apply_patch` notifications.
 *
 * Task 21 wires this to the shared `DiffViewer` (lifted out of the Claude
 * tool widgets in Task 18) so Codex patch items render their unified
 * diff inline.
 */
export function ApplyPatchItem({ message: _message }: { message: AgentMessage }): JSX.Element {
  return <div data-codex-item="item.apply_patch">codex: item.apply_patch</div>;
}
