import type { JsonlNode } from "@/types/jsonl";
import { isTaskLifecycleMarker } from "@/lib/subagentStreams";
import { isSubagentPrompt } from "@/lib/subagentDispatch";
import { detectSkillInjection } from "@/lib/skillDetection";
import type { HardFilters } from "@/lib/messageRenderingConfig";

// SDK subtypes the renderer treats as hook-lifecycle noise. `hook_progress`
// (mid-hook stdout/stderr) belongs in the set because it's plumbing —
// without it the message leaked into messages[] as system.unknown gray
// strips. `user_prompt_submit` is a hook *event* name (not an SDK
// message subtype) but historical sessions stamped it as a subtype,
// so it stays in the set for backward compatibility.
const HOOK_LIFECYCLE_SUBTYPES: ReadonlySet<string> = new Set([
  "hook_started",
  "hook_progress",
  "hook_response",
  "user_prompt_submit",
]);

function isHookLifecycleMarker(msg: JsonlNode): boolean {
  if (msg.kind !== "system") return false;
  return HOOK_LIFECYCLE_SUBTYPES.has(msg.subtype);
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
 * - When `hardFilters.hideHookLifecycle` is on (default), SDK hook
 *   lifecycle events (hook_started / hook_response / user_prompt_submit).
 */
export function filterDisplayableMessages(
  messages: JsonlNode[],
  hardFilters?: HardFilters,
): JsonlNode[] {
  // Backward-compat: missing config means apply legacy defaults (everything on).
  // hideHookLifecycle replaces the old dropHookLifecycle key.
  const hideHookLifecycle = hardFilters?.hideHookLifecycle ?? true;

  return messages.filter((message, index) => {
    // Skill-injection user messages have isMeta:true in the persisted
    // JSONL (the SDK live-stream variant uses isSynthetic instead) but
    // they carry the SKILL.md body — which we want to render. Detect
    // them here so the meta-noise filter below doesn't drop them, and
    // the user-message isMeta filter further down doesn't either.
    const isMeta = message.kind === 'user' && (message.raw as { isMeta?: boolean }).isMeta === true;
    const isSkillInjected = isMeta && !!detectSkillInjection(message, messages);

    // Skip meta messages that don't have meaningful content. Compaction
    // summaries (`type: 'summary'`) are exempt — they're meta in the JSONL
    // sense but carry the only signal that the prior history was compacted,
    // so the dedicated SummaryWidget needs them.
    const rawShape = (message as unknown as { raw?: { type?: string } }).raw;
    const rawType = rawShape?.type;
    if (isMeta && rawType !== 'summary' && !isSkillInjected) {
      return false;
    }

    // Skip subagent lifecycle markers — shown in SubagentBar instead
    if (isTaskLifecycleMarker(rawShape)) {
      return false;
    }

    // Skip SDK hook lifecycle events when the user has the filter on.
    if (hideHookLifecycle && isHookLifecycleMarker(message)) {
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
    if (message.kind === "user") {
      if (isMeta && !isSkillInjected) return false;

      const msgContent = (message.raw as { message?: { content?: unknown } }).message?.content;
      // Boundary normalization (see lib/normalizeMessage) guarantees
      // `msg.content` is an array here; treat a non-array as "no content".
      if (!Array.isArray(msgContent) || msgContent.length === 0) {
        return false;
      }

      {
        let hasVisibleContent = false;
        for (const content of msgContent as Array<{ type?: string; tool_use_id?: string; name?: string }>) {
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
                if (prevMsg.kind === "assistant") {
                  const prevContent = (prevMsg.raw as { message?: { content?: unknown } }).message?.content;
                  if (Array.isArray(prevContent)) {
                    const toolUse = prevContent.find(
                      (c) =>
                        (c as { type?: string }).type === "tool_use" &&
                        (c as { id?: string }).id === content.tool_use_id,
                    ) as { type: 'tool_use'; name?: string } | undefined;
                    if (toolUse) {
                      const toolName = toolUse.name?.toLowerCase();
                      const toolsWithWidgets = [
                        "edit",
                        "multiedit",
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
                        (toolName !== undefined &&
                          toolsWithWidgets.includes(toolName)) ||
                        toolUse.name?.startsWith("mcp__")
                      ) {
                        willBeSkipped = true;
                      }
                      break;
                    }
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
