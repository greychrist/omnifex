import type { JsonlNode } from "@/types/jsonl";
import { isTaskLifecycleMarker, isTaskNotificationCarrier } from "@/lib/subagentStreams";
import { forwardedParentToolUseId, isSubagentPrompt } from "@/lib/subagentDispatch";
import { detectSkillInjection } from "@/lib/skillDetection";
import { toolResultHasImages } from "@/lib/toolResultImages";
import { isCliSidechannelRecord } from "@/lib/cliSidechannelRecords";
import { titleChangeIndices } from "@/lib/sessionTitle";
import { summariseContextAttachment } from "@/lib/contextLedger";

export function filterDisplayableMessages(messages: JsonlNode[]): JsonlNode[] {
  const keptTitles = titleChangeIndices(messages);

  return messages.filter((message, index) => {
    // Skill injections are isMeta in the JSONL (isSynthetic live) but carry the SKILL.md body.
    const isMeta = message.kind === 'user' && message.userKind !== 'peer-message' && (message.raw as { isMeta?: boolean }).isMeta === true;
    const isSkillInjected = isMeta && !!detectSkillInjection(message, messages);

    // A `type: 'summary'` record is meta but is the only signal the history was compacted.
    const rawShape = (message as unknown as { raw?: { type?: string } }).raw;
    const rawType = rawShape?.type;
    if (isMeta && rawType !== 'summary' && !isSkillInjected) {
      return false;
    }

    if (isTaskLifecycleMarker(rawShape)) {
      return false;
    }

    if (rawType === "command_lifecycle") {
      return false;
    }

    if (message.kind === "system" && message.subtype === "status") {
      return false;
    }

    // Attachments with no ledger summary render nothing, and an empty row still takes padding.
    if (message.kind === "attachment") {
      const att = (message.raw as { attachment?: Record<string, unknown> }).attachment;
      if (summariseContextAttachment(att) === null) return false;
    }

    if (message.kind === "ai-title" || message.kind === "custom-title") {
      return keptTitles.has(index);
    }

    if (isTaskNotificationCarrier(rawShape)) {
      return false;
    }

    if (message.kind === "unknown" && isCliSidechannelRecord(message.raw)) {
      return false;
    }

    // Safe as a bare check: no persisted main-chain assistant carries a parent_tool_use_id.
    if (message.kind === "assistant" && forwardedParentToolUseId(message.raw) !== null) {
      return false;
    }

    // The CLI stamps real user prompts with parent refs too, so isSubagentPrompt checks it points at a Task/Agent.
    if (isSubagentPrompt(message, messages)) {
      return false;
    }

    if (message.kind === "user") {
      // Drawn from `origin.body`; its content is the CLI's wrapper string.
      if (message.userKind === 'peer-message') return true;
      if (isMeta && !isSkillInjected) return false;

      const msgContent = (message.raw as { message?: { content?: unknown } }).message?.content;
      if (!Array.isArray(msgContent) || msgContent.length === 0) {
        return false;
      }

      {
        let hasVisibleContent = false;
        for (const content of msgContent as { type?: string; tool_use_id?: string; name?: string }[]) {
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
                      // Task/Agent deliberately absent: SubagentReturnedMarker renders their result.
                      if (
                        (toolName !== undefined &&
                          toolsWithWidgets.includes(toolName)) ||
                        toolUse.name?.startsWith("mcp__")
                      ) {
                        // Unless the result carries an image: MCPWidget discards `result`.
                        willBeSkipped = !toolResultHasImages(content);
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
            continue;
          }
          // Unknown blocks count as visible: the renderer has a catch-all card for them.
          hasVisibleContent = true;
          break;
        }
        if (!hasVisibleContent) {
          return false;
        }
      }
    }
    return true;
  });
}
