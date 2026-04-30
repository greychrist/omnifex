import type { ClaudeStreamMessage } from "@/types/claudeStream";
import { isTaskLifecycleMarker } from "@/lib/subagentStreams";
import { isSubagentPrompt } from "@/lib/subagentDispatch";
import type { HardFilters } from "@/lib/messageRenderingConfig";

const HOOK_LIFECYCLE_SUBTYPES = new Set([
  "hook_started",
  "hook_response",
  "user_prompt_submit",
]);

function isHookLifecycleMarker(msg: ClaudeStreamMessage): boolean {
  return (
    msg.type === "system" &&
    typeof msg.subtype === "string" &&
    HOOK_LIFECYCLE_SUBTYPES.has(msg.subtype)
  );
}

/**
 * Filters out messages that shouldn't be displayed in the session UI.
 *
 * Skips:
 * - Meta messages without meaningful content (no leafUuid or summary)
 * - User messages that only contain tool results already rendered by
 *   tool-specific widgets (e.g. Bash, Edit, Read, Grep, etc.)
 * - Subagent task lifecycle markers (task_started / task_progress /
 *   task_notification) — those are rendered in the SubagentBar.
 * - When `hardFilters.dropHookLifecycle` is on (default), SDK hook
 *   lifecycle events (hook_started / hook_response / user_prompt_submit).
 */
export function filterDisplayableMessages(
  messages: ClaudeStreamMessage[],
  hardFilters?: HardFilters,
): ClaudeStreamMessage[] {
  // Backward-compat: missing config means apply legacy defaults (everything on).
  const dropHookLifecycle = hardFilters?.dropHookLifecycle ?? true;

  return messages.filter((message, index) => {
    // Skip meta messages that don't have meaningful content
    if (message.isMeta && !message.leafUuid && !message.summary) {
      return false;
    }

    // Skip subagent lifecycle markers — shown in SubagentBar instead
    if (isTaskLifecycleMarker(message)) {
      return false;
    }

    // Skip SDK hook lifecycle events when the user has the filter on.
    if (dropHookLifecycle && isHookLifecycleMarker(message)) {
      return false;
    }

    // Skip the synthesized subagent prompt — its content is already
    // rendered by TaskWidget at the parent Task/Agent tool_use position.
    // We require the parent_tool_use_id to actually point at a Task/Agent
    // tool_use; the bare presence of the field is not enough, since the
    // CLI's JSONL persistence stamps real user prompts with parent
    // references for conversation-tree chaining.
    if (isSubagentPrompt(message, messages)) {
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
                    // NOTE: subagent dispatch (Task/Agent) is intentionally
                    // NOT in this skip list. The tool_result for a Task is
                    // rendered chronologically by SubagentReturnedMarker —
                    // dropping the parent user message would erase the
                    // subagent's output card entirely.
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
