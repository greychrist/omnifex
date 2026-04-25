import type { ClaudeStreamMessage } from "@/components/AgentExecution";
import { isTaskLifecycleMarker } from "@/lib/subagentStreams";

/**
 * Filters out messages that shouldn't be displayed in the session UI.
 *
 * Skips:
 * - Meta messages without meaningful content (no leafUuid or summary)
 * - User messages that only contain tool results already rendered by
 *   tool-specific widgets (e.g. Bash, Edit, Read, Grep, etc.)
 * - Subagent task lifecycle markers (task_started / task_progress /
 *   task_notification) — those are rendered in the SubagentBar.
 */
export function filterDisplayableMessages(
  messages: ClaudeStreamMessage[],
): ClaudeStreamMessage[] {
  return messages.filter((message, index) => {
    // Skip meta messages that don't have meaningful content
    if (message.isMeta && !message.leafUuid && !message.summary) {
      return false;
    }

    // Skip subagent lifecycle markers — shown in SubagentBar instead
    if (isTaskLifecycleMarker(message)) {
      return false;
    }

    // Skip user messages that only contain tool results that are already displayed
    if (message.type === "user" && message.message) {
      if (message.isMeta) return false;

      const msg = message.message;
      if (
        !msg.content ||
        (Array.isArray(msg.content) && msg.content.length === 0)
      ) {
        return false;
      }

      if (Array.isArray(msg.content)) {
        let hasVisibleContent = false;
        for (const content of msg.content) {
          if (content.type === "text") {
            hasVisibleContent = true;
            break;
          }
          if (content.type === "image") {
            hasVisibleContent = true;
            break;
          }
          if (content.type === "tool_result") {
            let willBeSkipped = false;
            if (content.tool_use_id) {
              // Look for the matching tool_use in previous assistant messages
              for (let i = index - 1; i >= 0; i--) {
                const prevMsg = messages[i];
                if (
                  prevMsg.type === "assistant" &&
                  prevMsg.message?.content &&
                  Array.isArray(prevMsg.message.content)
                ) {
                  const toolUse = prevMsg.message.content.find(
                    (c: any) =>
                      c.type === "tool_use" && c.id === content.tool_use_id,
                  );
                  if (toolUse) {
                    const toolName = toolUse.name?.toLowerCase();
                    const toolsWithWidgets = [
                      "task",
                      "edit",
                      "multiedit",
                      "todowrite",
                      "ls",
                      "read",
                      "glob",
                      "bash",
                      "write",
                      "grep",
                    ];
                    if (
                      toolsWithWidgets.includes(toolName) ||
                      toolUse.name?.startsWith("mcp__")
                    ) {
                      willBeSkipped = true;
                    }
                    break;
                  }
                }
              }
            }
            if (!willBeSkipped) {
              hasVisibleContent = true;
              break;
            }
          }
        }
        if (!hasVisibleContent) {
          return false;
        }
      }
    }
    return true;
  });
}
